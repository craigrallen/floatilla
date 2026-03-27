'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-floatilla-anchor-watch';
  plugin.name = 'Anchor Watch';
  plugin.description =
    'Anchor watch alarm with drag detection and webhook notifications.';

  let anchorPosition = null;
  let alarmRadius = 50;
  let alarmActive = false;
  let positionInterval = null;
  let options = {};

  // ── helpers ──────────────────────────────────────────────────────────

  function getSelfPath(path) {
    try {
      return app.getSelfPath(path);
    } catch (_) {
      try {
        const parts = path.split('.');
        let obj = app.signalk.self;
        for (const p of parts) {
          if (obj && typeof obj === 'object') {
            obj = obj[p];
          } else {
            return undefined;
          }
        }
        if (obj && typeof obj === 'object' && obj.value !== undefined) {
          return obj.value;
        }
        return obj;
      } catch (_) {
        return undefined;
      }
    }
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── SignalK notification ────────────────────────────────────────────

  function sendAlarmNotification(distance) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'notifications.anchor.dragAlarm',
              value: {
                state: 'emergency',
                method: ['visual', 'sound'],
                message: `Anchor drag detected! ${Math.round(distance)}m from drop point (radius: ${alarmRadius}m)`,
              },
            },
          ],
        },
      ],
    });
  }

  function clearAlarmNotification() {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: 'notifications.anchor.dragAlarm',
              value: {
                state: 'normal',
                method: [],
                message: 'Vessel within anchor radius',
              },
            },
          ],
        },
      ],
    });
  }

  // ── webhook ─────────────────────────────────────────────────────────

  function sendWebhook(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const parsed = url.parse(webhookUrl);
      const transport = parsed.protocol === 'https:' ? https : http;

      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'signalk-floatilla-anchor-watch/1.0',
        },
      };

      const req = transport.request(opts, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(
              new Error(
                `Webhook ${parsed.hostname} returned ${res.statusCode}: ${responseBody}`
              )
            );
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error(`Webhook ${parsed.hostname} timed out`));
      });

      req.write(body);
      req.end();
    });
  }

  async function dispatchWebhook(event, data) {
    const webhookUrl = options.webhookUrl;
    if (!webhookUrl) return;

    const payload = {
      event,
      pluginId: plugin.id,
      timestamp: new Date().toISOString(),
      ...data,
    };

    try {
      await sendWebhook(webhookUrl, payload);
      app.debug(`Webhook sent: ${event}`);
    } catch (err) {
      app.error(`Webhook failed: ${err.message}`);
    }
  }

  // ── position monitoring ─────────────────────────────────────────────

  function checkPosition() {
    if (!anchorPosition) return;

    const pos = getSelfPath('navigation.position');
    if (!pos || pos.latitude == null || pos.longitude == null) return;

    const distance = haversineDistance(
      anchorPosition.latitude,
      anchorPosition.longitude,
      pos.latitude,
      pos.longitude
    );

    app.debug(
      `Anchor watch: ${Math.round(distance)}m from drop point (radius: ${alarmRadius}m)`
    );

    if (distance > alarmRadius && !alarmActive) {
      alarmActive = true;
      app.debug('Anchor drag alarm TRIGGERED');
      sendAlarmNotification(distance);
      dispatchWebhook('anchor.dragAlarm', {
        anchorPosition,
        vesselPosition: { latitude: pos.latitude, longitude: pos.longitude },
        distance: Math.round(distance),
        radius: alarmRadius,
        message: `Anchor drag detected! ${Math.round(distance)}m from drop point (radius: ${alarmRadius}m)`,
      });
    } else if (distance <= alarmRadius && alarmActive) {
      alarmActive = false;
      app.debug('Anchor drag alarm CLEARED');
      clearAlarmNotification();
      dispatchWebhook('anchor.dragAlarmCleared', {
        anchorPosition,
        vesselPosition: { latitude: pos.latitude, longitude: pos.longitude },
        distance: Math.round(distance),
        radius: alarmRadius,
        message: 'Vessel returned within anchor radius',
      });
    }
  }

  // ── plugin API ──────────────────────────────────────────────────────

  function registerRoutes() {
    app.put(
      '/plugins/signalk-floatilla-anchor-watch/setAnchorPoint',
      (req, res) => {
        const { latitude, longitude, radius } = req.body || {};
        if (latitude == null || longitude == null) {
          return res
            .status(400)
            .json({ error: 'latitude and longitude are required' });
        }

        anchorPosition = { latitude, longitude };
        if (radius != null && radius > 0) {
          alarmRadius = radius;
        }
        alarmActive = false;

        clearAlarmNotification();

        app.debug(
          `Anchor set at ${latitude}, ${longitude} with radius ${alarmRadius}m`
        );

        dispatchWebhook('anchor.set', {
          anchorPosition,
          radius: alarmRadius,
          message: `Anchor set at ${latitude.toFixed(5)}, ${longitude.toFixed(5)} (radius: ${alarmRadius}m)`,
        });

        res.json({
          state: 'ok',
          anchorPosition,
          radius: alarmRadius,
        });
      }
    );

    app.put(
      '/plugins/signalk-floatilla-anchor-watch/clearAnchorPoint',
      (req, res) => {
        anchorPosition = null;
        alarmActive = false;

        clearAlarmNotification();

        app.debug('Anchor point cleared');

        dispatchWebhook('anchor.cleared', {
          message: 'Anchor point cleared',
        });

        res.json({ state: 'ok', message: 'Anchor point cleared' });
      }
    );

    app.get(
      '/plugins/signalk-floatilla-anchor-watch/status',
      (req, res) => {
        const pos = getSelfPath('navigation.position');
        let distance = null;
        if (anchorPosition && pos && pos.latitude != null) {
          distance = Math.round(
            haversineDistance(
              anchorPosition.latitude,
              anchorPosition.longitude,
              pos.latitude,
              pos.longitude
            )
          );
        }

        res.json({
          anchorSet: anchorPosition != null,
          anchorPosition,
          radius: alarmRadius,
          alarmActive,
          currentDistance: distance,
          vesselPosition: pos || null,
        });
      }
    );
  }

  // ── plugin lifecycle ────────────────────────────────────────────────

  plugin.start = function (opts) {
    options = opts || {};
    alarmRadius = options.radius || 50;
    alarmActive = false;
    anchorPosition = null;

    const checkIntervalMs = (options.checkIntervalSeconds || 10) * 1000;

    registerRoutes();

    positionInterval = setInterval(checkPosition, checkIntervalMs);

    app.debug(
      `Anchor watch started (radius: ${alarmRadius}m, interval: ${checkIntervalMs / 1000}s)`
    );
  };

  plugin.stop = function () {
    if (positionInterval) {
      clearInterval(positionInterval);
      positionInterval = null;
    }

    if (alarmActive) {
      clearAlarmNotification();
    }

    anchorPosition = null;
    alarmActive = false;
    options = {};

    app.debug('Anchor watch stopped');
  };

  // ── schema ──────────────────────────────────────────────────────────

  plugin.schema = {
    type: 'object',
    title: 'Anchor Watch',
    description:
      'Monitor anchor position and trigger alarms when the vessel drifts beyond the set radius.',
    properties: {
      radius: {
        type: 'number',
        title: 'Alarm Radius (meters)',
        description: 'Distance from anchor drop point that triggers an alarm',
        default: 50,
        minimum: 5,
        maximum: 1000,
      },
      checkIntervalSeconds: {
        type: 'number',
        title: 'Check Interval (seconds)',
        description: 'How often to check vessel position against anchor point',
        default: 10,
        minimum: 1,
        maximum: 300,
      },
      webhookUrl: {
        type: 'string',
        title: 'Webhook URL',
        description:
          'HTTP POST URL for alarm notifications (leave empty to disable)',
      },
    },
  };

  return plugin;
};
