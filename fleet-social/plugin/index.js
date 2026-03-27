const fetch = require('node-fetch');
const path = require('path');
const io = require('socket.io-client');

const DEFAULT_SERVER = 'https://fleet.signalk.community';
const LOCATION_INTERVAL_MS = 30000;
const SOG_THRESHOLD_KN = 0.5;
const TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh 1 day before expiry

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-fleet-social';
  plugin.name = 'Fleet Social';
  plugin.description = 'Social network for boats — connect with friends, share positions, and exchange messages';

  let serverUrl = DEFAULT_SERVER;
  let token = null;
  let userId = null;
  let socket = null;
  let locationTimer = null;
  let tokenExpiresAt = null;
  let credentials = null;
  let stopping = false;

  plugin.schema = {
    type: 'object',
    required: ['serverUrl'],
    properties: {
      serverUrl: {
        type: 'string',
        title: 'Relay Server URL',
        default: DEFAULT_SERVER
      },
      username: {
        type: 'string',
        title: 'Username'
      },
      password: {
        type: 'string',
        title: 'Password'
      },
      token: {
        type: 'string',
        title: 'Auth Token (auto-managed)',
        description: 'Automatically populated after login. Do not edit manually.'
      }
    }
  };

  // ── Helpers ──

  function apiUrl(endpoint) {
    return `${serverUrl}${endpoint}`;
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  }

  async function apiRequest(method, endpoint, body) {
    await ensureAuth();
    const opts = { method, headers: authHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(apiUrl(endpoint), opts);
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      if (data.code === 'TOKEN_EXPIRED') {
        app.debug('Token expired, re-authenticating...');
        token = null;
        await ensureAuth();
        opts.headers = authHeaders();
        const retry = await fetch(apiUrl(endpoint), opts);
        if (!retry.ok) throw new Error(`API ${method} ${endpoint}: ${retry.status}`);
        return retry.json();
      }
      throw new Error(`Unauthorized: ${data.error || res.status}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${method} ${endpoint}: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function authenticate() {
    if (!credentials) throw new Error('No credentials configured');
    try {
      const res = await fetch(apiUrl('/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: credentials.username, password: credentials.password })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Login failed: ${res.status}`);
      }
      const data = await res.json();
      token = data.token;
      userId = data.userId;
      tokenExpiresAt = decodeTokenExpiry(token);
      // Persist token in plugin config
      const config = app.readPluginOptions();
      if (config && config.configuration) {
        config.configuration.token = token;
        app.savePluginOptions(config.configuration);
      }
      app.debug('Authenticated as user', userId);
    } catch (err) {
      app.error('Authentication failed:', err.message);
      throw err;
    }
  }

  function decodeTokenExpiry(jwt) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  function isTokenValid() {
    if (!token) return false;
    if (!tokenExpiresAt) return true;
    return Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS;
  }

  async function ensureAuth() {
    if (!isTokenValid()) {
      await authenticate();
    }
  }

  // ── WebSocket ──

  function connectSocket() {
    if (socket) {
      socket.disconnect();
    }

    socket = io(serverUrl, {
      auth: { token },
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
      app.debug('WebSocket connected to relay server');
      app.setPluginStatus('Connected');
    });

    socket.on('disconnect', (reason) => {
      app.debug('WebSocket disconnected:', reason);
      if (!stopping) {
        app.setPluginStatus('Disconnected — reconnecting...');
      }
    });

    socket.on('connect_error', async (err) => {
      app.debug('WebSocket connection error:', err.message);
      if (err.message.includes('expired') || err.message.includes('Invalid')) {
        try {
          await authenticate();
          socket.auth = { token };
          socket.connect();
        } catch (authErr) {
          app.error('WebSocket re-auth failed:', authErr.message);
        }
      }
    });

    socket.on('message', (msg) => {
      app.debug('Received message from', msg.username);
      // Push SignalK notification
      app.handleMessage(plugin.id, {
        updates: [{
          values: [{
            path: 'notifications.social.message',
            value: {
              state: 'normal',
              method: ['visual', 'sound'],
              message: `${msg.vesselName || msg.username}: ${msg.text}`
            }
          }]
        }]
      });
    });

    socket.on('location', (loc) => {
      app.debug('Friend location update:', loc.username);
      publishFriendPosition(loc);
    });

    socket.on('waypoint', (wp) => {
      app.debug('Received waypoint from', wp.username, ':', wp.name);
      // Push notification
      app.handleMessage(plugin.id, {
        updates: [{
          values: [{
            path: 'notifications.social.waypoint',
            value: {
              state: 'alert',
              method: ['visual', 'sound'],
              message: `\u2693 ${wp.vesselName || wp.username} shared a waypoint: ${wp.name} \u2014 Route there?`
            }
          }]
        }]
      });
      // Publish the waypoint as a navigation resource
      publishWaypointResource(wp);
    });
  }

  function publishFriendPosition(loc) {
    const friendKey = `fleet-social:${loc.userId}`;
    app.handleMessage(plugin.id, {
      context: `vessels.${friendKey}`,
      updates: [{
        values: [
          {
            path: 'navigation.position',
            value: { latitude: loc.lat, longitude: loc.lon }
          },
          {
            path: 'navigation.speedOverGround',
            value: (loc.sog || 0) * 0.514444 // knots to m/s
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: (loc.cog || 0) * (Math.PI / 180) // degrees to radians
          },
          {
            path: 'name',
            value: loc.vesselName || loc.username
          }
        ]
      }]
    });
  }

  function publishWaypointResource(wp) {
    try {
      const waypointPath = `resources.waypoints.fleet-social-${wp.id}`;
      app.handleMessage(plugin.id, {
        updates: [{
          values: [{
            path: waypointPath,
            value: {
              name: `${wp.name} (from ${wp.vesselName || wp.username})`,
              description: wp.description || '',
              position: { latitude: wp.lat, longitude: wp.lon },
              feature: {
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [wp.lon, wp.lat]
                },
                properties: {
                  name: wp.name,
                  sharedBy: wp.username
                }
              }
            }
          }]
        }]
      });
    } catch (err) {
      app.debug('Failed to publish waypoint resource:', err.message);
    }
  }

  // ── Location reporting ──

  function startLocationReporting() {
    locationTimer = setInterval(async () => {
      try {
        const pos = app.getSelfPath('navigation.position');
        const sog = app.getSelfPath('navigation.speedOverGround');
        const cog = app.getSelfPath('navigation.courseOverGroundTrue');
        const vesselName = app.getSelfPath('name');

        if (!pos || !pos.value) return;

        const sogKn = (sog && sog.value) ? sog.value / 0.514444 : 0; // m/s to knots
        if (sogKn < SOG_THRESHOLD_KN) return;

        const cogDeg = (cog && cog.value) ? cog.value * (180 / Math.PI) : 0;

        await apiRequest('PUT', '/location', {
          lat: pos.value.latitude,
          lon: pos.value.longitude,
          sog: sogKn,
          cog: cogDeg,
          vesselName: vesselName?.value || 'Unknown'
        });
        app.debug('Location reported');
      } catch (err) {
        app.debug('Location report failed:', err.message);
      }
    }, LOCATION_INTERVAL_MS);
  }

  // ── REST API endpoints ──

  function registerRoutes(router) {
    // Proxy: get messages
    router.get('/messages', async (req, res) => {
      try {
        const query = req.query.before ? `?before=${req.query.before}` : '';
        const data = await apiRequest('GET', `/messages${query}`);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: post message
    router.post('/messages', async (req, res) => {
      try {
        const data = await apiRequest('POST', '/messages', req.body);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: delete message
    router.delete('/messages/:id', async (req, res) => {
      try {
        const data = await apiRequest('DELETE', `/messages/${req.params.id}`);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: friend list
    router.get('/friends', async (req, res) => {
      try {
        const data = await apiRequest('GET', '/friends');
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: send friend request
    router.post('/friends/request', async (req, res) => {
      try {
        const data = await apiRequest('POST', '/friends/request', req.body);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: get pending requests
    router.get('/friends/requests', async (req, res) => {
      try {
        const data = await apiRequest('GET', '/friends/requests');
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: accept friend request
    router.post('/friends/accept/:userId', async (req, res) => {
      try {
        const data = await apiRequest('POST', `/friends/accept/${req.params.userId}`);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: remove friend
    router.delete('/friends/:userId', async (req, res) => {
      try {
        const data = await apiRequest('DELETE', `/friends/${req.params.userId}`);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: share waypoint (uses current vessel position)
    router.post('/waypoints', async (req, res) => {
      try {
        let { lat, lon, name, description } = req.body;
        // Default to current vessel position
        if (lat == null || lon == null) {
          const pos = app.getSelfPath('navigation.position');
          if (pos && pos.value) {
            lat = pos.value.latitude;
            lon = pos.value.longitude;
          } else {
            return res.status(400).json({ error: 'No position available' });
          }
        }
        const data = await apiRequest('POST', '/waypoints', { lat, lon, name, description });
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: get waypoints
    router.get('/waypoints', async (req, res) => {
      try {
        const data = await apiRequest('GET', '/waypoints');
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: accept waypoint
    router.post('/waypoints/:id/accept', async (req, res) => {
      try {
        const data = await apiRequest('POST', `/waypoints/${req.params.id}/accept`);
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    // Proxy: friend locations
    router.get('/friends/locations', async (req, res) => {
      try {
        const data = await apiRequest('GET', '/friends/locations');
        res.json(data);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });
  }

  // ── Plugin lifecycle ──

  plugin.start = async function (options) {
    stopping = false;
    serverUrl = (options.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
    credentials = (options.username && options.password)
      ? { username: options.username, password: options.password }
      : null;
    token = options.token || null;

    if (token) {
      tokenExpiresAt = decodeTokenExpiry(token);
      userId = null; // will be resolved on first API call
    }

    app.setPluginStatus('Starting...');

    // Register REST routes
    const express = require('express');
    const router = express.Router();
    router.use(express.json());
    registerRoutes(router);
    app.use('/plugins/fleet-social', router);

    // Serve webapp
    app.use('/plugins/fleet-social', express.static(path.join(__dirname, 'public')));

    try {
      await ensureAuth();
      connectSocket();
      startLocationReporting();
      app.setPluginStatus('Connected');
    } catch (err) {
      app.error('Fleet Social startup failed:', err.message);
      app.setPluginError(err.message);
    }
  };

  plugin.stop = function () {
    stopping = true;
    if (locationTimer) {
      clearInterval(locationTimer);
      locationTimer = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    app.setPluginStatus('Stopped');
  };

  return plugin;
};
