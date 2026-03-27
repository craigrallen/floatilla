const { Router } = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = Router();
router.use(authMiddleware);

// List my accepted friends with online status, last seen, last position
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const friends = db.prepare(`
      SELECT
        u.id, u.username, u.vessel_name,
        l.lat, l.lon, l.sog, l.cog, l.updated_at AS last_seen
      FROM friendships f
      JOIN users u ON u.id = CASE
        WHEN f.requester_id = ? THEN f.addressee_id
        ELSE f.requester_id
      END
      LEFT JOIN locations l ON l.user_id = u.id
      WHERE f.status = 'accepted'
        AND (f.requester_id = ? OR f.addressee_id = ?)
    `).all(req.userId, req.userId, req.userId);

    const connectedUsers = req.app.get('connectedUsers') || new Map();

    const result = friends.map(f => ({
      userId: f.id,
      username: f.username,
      vesselName: f.vessel_name,
      online: connectedUsers.has(f.id),
      lastSeen: f.last_seen || null,
      position: f.lat != null ? { lat: f.lat, lon: f.lon, sog: f.sog, cog: f.cog } : null
    }));

    res.json(result);
  } catch (err) {
    console.error('List friends error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send friend request
router.post('/request', (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const db = getDb();
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.id === req.userId) {
      return res.status(400).json({ error: 'Cannot friend yourself' });
    }

    // Check existing friendship in either direction
    const existing = db.prepare(`
      SELECT id, status FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?)
         OR (requester_id = ? AND addressee_id = ?)
    `).get(req.userId, target.id, target.id, req.userId);

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: 'Already friends' });
      }
      return res.status(409).json({ error: 'Friend request already pending' });
    }

    db.prepare(
      'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)'
    ).run(req.userId, target.id, 'pending');

    res.status(201).json({ message: 'Friend request sent' });
  } catch (err) {
    console.error('Friend request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get incoming pending friend requests
router.get('/requests', (req, res) => {
  try {
    const db = getDb();
    const requests = db.prepare(`
      SELECT f.id AS requestId, u.id AS userId, u.username, u.vessel_name, f.created_at
      FROM friendships f
      JOIN users u ON u.id = f.requester_id
      WHERE f.addressee_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `).all(req.userId);

    res.json(requests.map(r => ({
      requestId: r.requestId,
      userId: r.userId,
      username: r.username,
      vesselName: r.vessel_name,
      createdAt: r.created_at
    })));
  } catch (err) {
    console.error('List requests error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept friend request
router.post('/accept/:userId', (req, res) => {
  try {
    const fromUserId = parseInt(req.params.userId, 10);
    if (isNaN(fromUserId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const db = getDb();
    const result = db.prepare(`
      UPDATE friendships SET status = 'accepted'
      WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'
    `).run(fromUserId, req.userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'No pending request from this user' });
    }

    res.json({ message: 'Friend request accepted' });
  } catch (err) {
    console.error('Accept friend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove friend
router.delete('/:userId', (req, res) => {
  try {
    const friendId = parseInt(req.params.userId, 10);
    if (isNaN(friendId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const db = getDb();
    const result = db.prepare(`
      DELETE FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?)
         OR (requester_id = ? AND addressee_id = ?)
    `).run(req.userId, friendId, friendId, req.userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    res.json({ message: 'Friend removed' });
  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all friends' current positions
router.get('/locations', (req, res) => {
  try {
    const db = getDb();
    const locations = db.prepare(`
      SELECT u.id, u.username, u.vessel_name, l.lat, l.lon, l.sog, l.cog, l.updated_at
      FROM friendships f
      JOIN users u ON u.id = CASE
        WHEN f.requester_id = ? THEN f.addressee_id
        ELSE f.requester_id
      END
      JOIN locations l ON l.user_id = u.id
      WHERE f.status = 'accepted'
        AND (f.requester_id = ? OR f.addressee_id = ?)
    `).all(req.userId, req.userId, req.userId);

    res.json(locations.map(l => ({
      userId: l.id,
      username: l.username,
      vesselName: l.vessel_name,
      lat: l.lat,
      lon: l.lon,
      sog: l.sog,
      cog: l.cog,
      updatedAt: l.updated_at
    })));
  } catch (err) {
    console.error('Friends locations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
