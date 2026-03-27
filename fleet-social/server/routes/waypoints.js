const { Router } = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = Router();
router.use(authMiddleware);

// Share a waypoint with friends
router.post('/', (req, res) => {
  try {
    const { lat, lon, name, description } = req.body;
    if (lat == null || lon == null || !name) {
      return res.status(400).json({ error: 'lat, lon, and name are required' });
    }
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'lat and lon must be numbers' });
    }

    const db = getDb();
    const result = db.prepare(
      'INSERT INTO waypoints (user_id, lat, lon, name, description) VALUES (?, ?, ?, ?, ?)'
    ).run(req.userId, lat, lon, name, description || '');

    const user = db.prepare('SELECT username, vessel_name FROM users WHERE id = ?').get(req.userId);

    const waypoint = {
      id: result.lastInsertRowid,
      userId: req.userId,
      username: user.username,
      vesselName: user.vessel_name,
      lat, lon, name,
      description: description || '',
      createdAt: new Date().toISOString()
    };

    // Emit to friends via Socket.io
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
        io.to(`user:${friendId}`).emit('waypoint', waypoint);
      }
    }

    res.status(201).json(waypoint);
  } catch (err) {
    console.error('Share waypoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get waypoints shared by friends (unacknowledged by me)
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const waypoints = db.prepare(`
      SELECT w.id, w.user_id, w.lat, w.lon, w.name, w.description, w.created_at,
             u.username, u.vessel_name
      FROM waypoints w
      JOIN users u ON u.id = w.user_id
      JOIN friendships f ON f.status = 'accepted'
        AND ((f.requester_id = ? AND f.addressee_id = w.user_id)
          OR (f.addressee_id = ? AND f.requester_id = w.user_id))
      LEFT JOIN waypoint_acks wa ON wa.waypoint_id = w.id AND wa.user_id = ?
      WHERE w.user_id != ? AND wa.waypoint_id IS NULL
      ORDER BY w.created_at DESC
    `).all(req.userId, req.userId, req.userId, req.userId);

    res.json(waypoints.map(w => ({
      id: w.id,
      userId: w.user_id,
      username: w.username,
      vesselName: w.vessel_name,
      lat: w.lat,
      lon: w.lon,
      name: w.name,
      description: w.description,
      createdAt: w.created_at
    })));
  } catch (err) {
    console.error('Get waypoints error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept (acknowledge) a waypoint
router.post('/:id/accept', (req, res) => {
  try {
    const waypointId = parseInt(req.params.id, 10);
    if (isNaN(waypointId)) {
      return res.status(400).json({ error: 'Invalid waypoint ID' });
    }

    const db = getDb();
    const wp = db.prepare('SELECT id FROM waypoints WHERE id = ?').get(waypointId);
    if (!wp) {
      return res.status(404).json({ error: 'Waypoint not found' });
    }

    db.prepare(`
      INSERT OR IGNORE INTO waypoint_acks (waypoint_id, user_id) VALUES (?, ?)
    `).run(waypointId, req.userId);

    res.json({ message: 'Waypoint accepted' });
  } catch (err) {
    console.error('Accept waypoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
