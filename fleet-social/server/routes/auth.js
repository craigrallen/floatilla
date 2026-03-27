const { Router } = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db');
const { signToken } = require('../auth');

const router = Router();
const SALT_ROUNDS = 12;

router.post('/register', async (req, res) => {
  try {
    const { username, vesselName, password } = req.body;
    if (!username || !vesselName || !password) {
      return res.status(400).json({ error: 'username, vesselName, and password are required' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers, hyphens, and underscores' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (username, vessel_name, password_hash) VALUES (?, ?, ?)'
    ).run(username, vesselName, passwordHash);

    const token = signToken(result.lastInsertRowid);
    res.status(201).json({ token, userId: result.lastInsertRowid });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken(user.id);
    res.json({ token, userId: user.id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
