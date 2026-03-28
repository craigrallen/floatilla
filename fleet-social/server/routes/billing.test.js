/**
 * Smoke tests for /billing routes.
 * Run with: node billing.test.js
 * Requires the server to be started separately on port 3100, OR
 * uses the in-process approach below.
 */

const assert = require('assert');
const http = require('http');

const BASE = 'http://localhost:3100';

async function get(path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3100,
      path, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(path, body, token) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3100,
      path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  // 1. Register test user
  const reg = await post('/auth/register', {
    username: 'billingtest_' + Date.now(),
    vesselName: 'MV Test',
    password: 'password123'
  });
  assert.strictEqual(reg.status, 201, 'register should return 201');
  const token = reg.body.token;
  assert.ok(token, 'should have token');

  // 2. /billing/status should return free plan
  const status = await get('/billing/status', token);
  assert.strictEqual(status.status, 200, 'status should return 200');
  assert.strictEqual(status.body.plan, 'free', 'default plan should be free');
  assert.strictEqual(status.body.isPro, false, 'default isPro should be false');

  // 3. /billing/status without token should return 401
  const noAuth = await get('/billing/status');
  assert.strictEqual(noAuth.status, 401, 'unauthenticated should return 401');

  // 4. /billing/checkout without required fields should return 400
  const badCheckout = await post('/billing/checkout', {}, token);
  assert.strictEqual(badCheckout.status, 400, 'missing priceId should return 400');

  // 5. /billing/portal without existing customer should return 404
  const noPortal = await post('/billing/portal', { returnUrl: 'https://example.com' }, token);
  assert.strictEqual(noPortal.status, 404, 'portal without customer should return 404');

  console.log('All billing smoke tests passed ✓');
}

run().catch(err => { console.error('Test failed:', err); process.exit(1); });
