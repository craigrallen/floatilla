const { Router } = require('express');
const Stripe = require('stripe');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = Router();

// Stripe client — loaded lazily so server starts without key during dev
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' });
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// ─── DB helpers ──────────────────────────────────────────────────────────────

function upsertSubscription(userId, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id,
      plan, status, current_period_end, cancel_at_period_end, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      stripe_customer_id    = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan                  = excluded.plan,
      status                = excluded.status,
      current_period_end    = excluded.current_period_end,
      cancel_at_period_end  = excluded.cancel_at_period_end,
      updated_at            = excluded.updated_at
  `).run(
    userId,
    data.customerId,
    data.subscriptionId || null,
    data.plan || 'free',
    data.status || 'inactive',
    data.currentPeriodEnd || null,
    data.cancelAtPeriodEnd ? 1 : 0
  );
}

function getSubscription(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
}

function getUserByCustomerId(customerId) {
  const db = getDb();
  return db.prepare('SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?').get(customerId);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /billing/status
 * Returns the current user's subscription status and plan.
 */
router.get('/status', authMiddleware, (req, res) => {
  try {
    const sub = getSubscription(req.userId);
    if (!sub || sub.status === 'inactive' || sub.plan === 'free') {
      return res.json({ plan: 'free', status: 'inactive', isPro: false });
    }
    const isPro = sub.status === 'active' || sub.status === 'trialing';
    res.json({
      plan: sub.plan,
      status: sub.status,
      isPro,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    });
  } catch (err) {
    console.error('billing/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /billing/checkout
 * Body: { priceId, successUrl, cancelUrl }
 * Creates a Stripe Checkout session for Floatilla Pro.
 */
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { priceId, successUrl, cancelUrl } = req.body;

    if (!priceId || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'priceId, successUrl, and cancelUrl are required' });
    }

    const stripe = getStripe();
    const db = getDb();

    // Look up or create Stripe customer
    let sub = getSubscription(req.userId);
    let customerId = sub?.stripe_customer_id;

    if (!customerId) {
      const user = db.prepare('SELECT username, vessel_name FROM users WHERE id = ?').get(req.userId);
      const customer = await stripe.customers.create({
        name: user.vessel_name,
        metadata: { floatillaUserId: String(req.userId), username: user.username },
      });
      customerId = customer.id;
      // Persist customer id immediately
      upsertSubscription(req.userId, { customerId, plan: 'free', status: 'inactive' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: { floatillaUserId: String(req.userId) },
      },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('billing/checkout error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /billing/portal
 * Creates a Stripe Customer Portal session for the current user.
 */
router.post('/portal', authMiddleware, async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const sub = getSubscription(req.userId);

    if (!sub?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found for this user' });
    }

    const stripe = getStripe();

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: returnUrl || process.env.APP_URL || 'https://floatilla.app',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('billing/portal error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * POST /billing/webhook
 * Stripe webhook — must be mounted WITHOUT bodyParser so the raw body is available.
 * Handles: checkout.session.completed, customer.subscription.updated/deleted
 */
router.post('/webhook', async (req, res) => {
  let event;

  if (WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // Dev mode — no signature verification
    try {
      event = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  try {
    await handleWebhookEvent(event);
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Still return 200 to prevent Stripe from retrying for internal errors
  }

  res.json({ received: true });
});

async function handleWebhookEvent(event) {
  console.log(`Stripe webhook: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') break;

      const userId = parseInt(session.metadata?.floatillaUserId || session.subscription_data?.metadata?.floatillaUserId, 10);
      if (!userId) {
        // Fallback: look up by customer id
        const row = getUserByCustomerId(session.customer);
        if (!row) { console.warn('checkout.session.completed: no userId found'); break; }
      }

      const resolvedUserId = userId || getUserByCustomerId(session.customer)?.user_id;
      if (!resolvedUserId) break;

      // Fetch the subscription to get plan/status
      const stripe = getStripe();
      const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
      const plan = stripeSub.items.data[0]?.price?.lookup_key || 'pro';

      upsertSubscription(resolvedUserId, {
        customerId: session.customer,
        subscriptionId: session.subscription,
        plan,
        status: stripeSub.status,
        currentPeriodEnd: new Date(stripeSub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      });
      console.log(`User ${resolvedUserId} subscribed to ${plan} (${stripeSub.status})`);
      break;
    }

    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      const row = getUserByCustomerId(stripeSub.customer);
      if (!row) break;

      const plan = stripeSub.items.data[0]?.price?.lookup_key || 'pro';
      upsertSubscription(row.user_id, {
        customerId: stripeSub.customer,
        subscriptionId: stripeSub.id,
        plan,
        status: stripeSub.status,
        currentPeriodEnd: new Date(stripeSub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      });
      console.log(`User ${row.user_id} subscription updated: ${stripeSub.status}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;
      const row = getUserByCustomerId(stripeSub.customer);
      if (!row) break;

      upsertSubscription(row.user_id, {
        customerId: stripeSub.customer,
        subscriptionId: stripeSub.id,
        plan: 'free',
        status: 'canceled',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
      console.log(`User ${row.user_id} subscription canceled`);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const row = getUserByCustomerId(invoice.customer);
      if (!row) break;
      const db = getDb();
      db.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now') WHERE user_id = ?`).run(row.user_id);
      console.log(`User ${row.user_id} payment failed — marked past_due`);
      break;
    }

    default:
      // Unhandled event type — no-op
      break;
  }
}

module.exports = router;
