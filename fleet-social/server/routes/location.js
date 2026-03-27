const { Router } = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = Router();
router.use(authMiddleware);

// Update my current position
router.put('/', (req, res) => {
  try {
    const { lat, lon, sog, cog, vesselName } = req.body;
    if (lat == null || lon == null) {
      return res.status(400).json({ error: 'lat and lon are required' });
    }
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'lat and lon must be numbers' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const db = getDb();

    db.prepare(`
      INSERT INTO locations (user_id, lat, lon, sog, cog, vessel_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        lat = excluded.lat,
        lon = excluded.lon,
        sog = excluded.sog,
        cog = excluded.cog,
        vessel_name = excluded.vessel_name,
        updated_at = datetime('now')
    `).run(req.userId, lat, lon, sog || 0, cog || 0, vesselName || null);

    // Emit location update to friends via Socket.io
    const io = req.app.get('io');
    if (io) {
      const user = db.prepare('SELECT username, vessel_name FROM users WHERE id = ?').get(req.userId);
      const friendIds = db.prepare(`
        SELECT CASE
          WHEN requester_id = ? THEN addressee_id
          ELSE requester_id
        END AS friend_id
        FROM friendships
        WHERE status = 'accepted'
          AND (requester_id = ? OR addressee_id = ?)
      `).all(req.userId, req.userId, req.userId).map(r => r.friend_id);

      const locationData = {
        userId: req.userId,
        username: user.username,
        vesselName: user.vessel_name,
        lat, lon,
        sog: sog || 0,
        cog: cog || 0,
        updatedAt: new Date().toISOString()
      };

      for (const friendId of friendIds) {
        io.to(`user:${friendId}`).emit('location', locationData);
      }
    }

    res.json({ message: 'Position updated' });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
