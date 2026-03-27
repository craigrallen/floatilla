const { Router } = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = Router();
router.use(authMiddleware);

const MAX_TEXT_LENGTH = 280;
const DEFAULT_PAGE_SIZE = 50;

// Get messages from friends (newest first, paginated)
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 100);
    const before = req.query.before || null; // ISO timestamp or message ID for cursor

    const db = getDb();

    // Get my friend IDs
    const friendIds = db.prepare(`
      SELECT CASE
        WHEN requester_id = ? THEN addressee_id
        ELSE requester_id
      END AS friend_id
      FROM friendships
      WHERE status = 'accepted'
        AND (requester_id = ? OR addressee_id = ?)
    `).all(req.userId, req.userId, req.userId).map(r => r.friend_id);

    // Include own messages in feed
    const userIds = [req.userId, ...friendIds];
    if (userIds.length === 0) {
      return res.json({ messages: [], hasMore: false });
    }

    const placeholders = userIds.map(() => '?').join(',');

    let query, params;
    if (before) {
      query = `
        SELECT m.id, m.user_id, m.text, m.lat, m.lon, m.created_at, u.username, u.vessel_name
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.user_id IN (${placeholders}) AND m.id < ?
        ORDER BY m.id DESC
        LIMIT ?
      `;
      params = [...userIds, parseInt(before, 10), limit + 1];
    } else {
      query = `
        SELECT m.id, m.user_id, m.text, m.lat, m.lon, m.created_at, u.username, u.vessel_name
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.user_id IN (${placeholders})
        ORDER BY m.id DESC
        LIMIT ?
      `;
      params = [...userIds, limit + 1];
    }

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      vesselName: m.vessel_name,
      text: m.text,
      position: m.lat != null ? { lat: m.lat, lon: m.lon } : null,
      createdAt: m.created_at,
      own: m.user_id === req.userId
    }));

    res.json({ messages, hasMore });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Post a message
router.post('/', (req, res) => {
  try {
    const { text, attachLocation } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_TEXT_LENGTH} characters or less` });
    }

    const db = getDb();
    let lat = null, lon = null;

    if (attachLocation) {
      const loc = db.prepare('SELECT lat, lon FROM locations WHERE user_id = ?').get(req.userId);
      if (loc) {
        lat = loc.lat;
        lon = loc.lon;
      }
    }

    const result = db.prepare(
      'INSERT INTO messages (user_id, text, lat, lon) VALUES (?, ?, ?, ?)'
    ).run(req.userId, text, lat, lon);

    const user = db.prepare('SELECT username, vessel_name FROM users WHERE id = ?').get(req.userId);

    const message = {
      id: result.lastInsertRowid,
      userId: req.userId,
      username: user.username,
      vesselName: user.vessel_name,
      text,
      position: lat != null ? { lat, lon } : null,
      createdAt: new Date().toISOString(),
      own: true
    };

    // Emit to connected friends via Socket.io
    const io = req.app.get('io');
    if (io) {
      const friendIds = db.prepare(`
        SELECT CASE
          WHEN requester_id = ? THEN addressee_id
          ELSE requester_id
        END AS friend_id
        FROM friendships
        WHERE status = 'accepted'
          AND (requester_id = ? OR addressee_id = ?)
      `).all(req.userId, req.userId, req.userId).map(r => r.friend_id);

      for (const friendId of friendIds) {
        io.to(`user:${friendId}`).emit('message', { ...message, own: false });
      }
    }

    res.status(201).json(message);
  } catch (err) {
    console.error('Post message error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete own message
router.delete('/:id', (req, res) => {
  try {
    const messageId = parseInt(req.params.id, 10);
    if (isNaN(messageId)) {
      return res.status(400).json({ error: 'Invalid message ID' });
    }

    const db = getDb();
    const result = db.prepare(
      'DELETE FROM messages WHERE id = ? AND user_id = ?'
    ).run(messageId, req.userId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Message not found or not owned by you' });
    }

    res.json({ message: 'Message deleted' });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
