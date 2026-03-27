'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const DAY_MS = 86400000;

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-floatilla-bilge';
  plugin.name = 'Bilge Pump Monitor';
  plugin.description =
    'Bilge pump cycle counter and frequency alert — monitors pump on/off transitions, tracks runtime, alerts on high frequency or long-running cycles';

  // ── State ──────────────────────────────────────────────────────────────────
  let config = {};
  let unsubscribes = [];
  let intervals = [];

  // Pump state tracking
  let pumpOn = false;
  let cycleStartTime = null;      // when current ON cycle began
  let cycles = [];                 // [{ startTime, endTime, durationMs }] — rolling 24h window
  let totalDailyRuntimeMs = 0;    // accumulated pump runtime today
  let lastDateStr = null;          // for midnight reset

  // Alert debounce
  let highFrequencyAlertActive = false;
  let longCycleAlertActive = false;
  let lastWebhookTime = 0;

  // ── Schema ─────────────────────────────────────────────────────────────────
  plugin.schema = {
    type: 'object',
    title: 'Bilge Pump Monitor Configuration',
    properties: {
      pumpPath: {
        type: 'string',
        title: 'Bilge pump state path',
        description:
          'SignalK path for bilge pump state. Use electrical.switches.bilgePump.state or propulsion.*.bilgePump.state',
        default: 'electrical.switches.bilgePump.state'
      },
      frequencyAlarmThreshold: {
        type: 'number',
        title: 'Frequency alarm threshold (cycles/hour)',
        description: 'Alert when pump cycles per hour exceeds this value (potential flooding)',
        default: 4
      },
      longCycleDurationMinutes: {
        type: 'number',
        title: 'Long cycle alarm (minutes)',
        description: 'Alert when a single pump cycle runs continuously longer than this',
        default: 5
      },
      publishIntervalSeconds: {
        type: 'number',
        title: 'Publish interval (seconds)',
        description: 'How often to publish cycle count and frequency to SignalK',
        default: 10
      },
      webhookUrl: {
        type: 'string',
        title: 'Webhook URL',
        description:
          'HTTP(S) endpoint to POST high-frequency alerts to. Leave empty to disable webhook notifications.',
        default: ''
      },
      webhookCooldownMinutes: {
        type: 'number',
        title: 'Webhook cooldown (minutes)',
        description: 'Minimum time between webhook notifications',
        default: 15
      }
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function sendDelta(pathStr, value) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: pathStr,
              value: value
            }
          ]
        }
      ]
    });
  }

  function sendNotification(pathSuffix, message, state, method) {
    sendDelta('notifications.' + pathSuffix, {
      state: state || 'alert',
      method: method || ['visual', 'sound'],
      message: message,
      timestamp: new Date().toISOString()
    });
  }

  function clearNotification(pathSuffix) {
    sendDelta('notifications.' + pathSuffix, {
      state: 'normal',
      method: [],
      message: '',
      timestamp: new Date().toISOString()
    });
  }

  function pruneCycles() {
    const cutoff = Date.now() - DAY_MS;
    while (cycles.length > 0 && cycles[0].endTime < cutoff) {
      cycles.shift();
    }
  }

  function countCyclesInWindow(windowMs) {
    const cutoff = Date.now() - windowMs;
    return cycles.filter((c) => c.endTime >= cutoff).length;
  }

  function runtimeInWindow(windowMs) {
    const cutoff = Date.now() - windowMs;
    let total = 0;
    for (const c of cycles) {
      if (c.endTime >= cutoff) {
        const effectiveStart = Math.max(c.startTime, cutoff);
        total += c.endTime - effectiveStart;
      }
    }
    // Include current running cycle
    if (pumpOn && cycleStartTime) {
      const effectiveStart = Math.max(cycleStartTime, cutoff);
      total += Date.now() - effectiveStart;
    }
    return total;
  }

  function cyclesPerHour() {
    return countCyclesInWindow(HOUR_MS);
  }

  // ── Pump state handler ─────────────────────────────────────────────────────

  function handlePumpState(value) {
    const isOn = value === 1 || value === true || value === 'on' || value === 'ON';
    const isOff = value === 0 || value === false || value === 'off' || value === 'OFF';

    if (isOn && !pumpOn) {
      // Pump turned ON — start of a new cycle
      pumpOn = true;
      cycleStartTime = Date.now();
      app.debug('Bilge pump ON — cycle started');
    } else if (isOff && pumpOn) {
      // Pump turned OFF — end of cycle
      pumpOn = false;
      const now = Date.now();
      const durationMs = now - cycleStartTime;

      cycles.push({
        startTime: cycleStartTime,
        endTime: now,
        durationMs: durationMs
      });

      totalDailyRuntimeMs += durationMs;
      cycleStartTime = null;

      app.debug(
        'Bilge pump OFF — cycle ended, duration %ds, total cycles(1h): %d',
        Math.round(durationMs / 1000),
        cyclesPerHour()
      );

      // Clear long-cycle alert if it was active
      if (longCycleAlertActive) {
        longCycleAlertActive = false;
        clearNotification('bilge.longCycle');
      }

      pruneCycles();
    }
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  function checkAlerts() {
    const freq = cyclesPerHour();
    const threshold = config.frequencyAlarmThreshold;

    // High frequency alert
    if (freq > threshold && !highFrequencyAlertActive) {
      highFrequencyAlertActive = true;
      const msg = `Bilge pump high frequency: ${freq} cycles/hour (threshold: ${threshold}). Potential flooding!`;
      sendNotification('bilge.highFrequency', msg, 'emergency', ['visual', 'sound']);
      app.debug(msg);
      postWebhook(msg, freq);
    } else if (freq <= threshold && highFrequencyAlertActive) {
      highFrequencyAlertActive = false;
      clearNotification('bilge.highFrequency');
      app.debug('Bilge pump frequency back to normal: %d cycles/hour', freq);
    }

    // Long cycle alert — check if pump has been running too long
    if (pumpOn && cycleStartTime) {
      const runningMs = Date.now() - cycleStartTime;
      const limitMs = config.longCycleDurationMinutes * MINUTE_MS;

      if (runningMs > limitMs && !longCycleAlertActive) {
        longCycleAlertActive = true;
        const runningMin = Math.round(runningMs / MINUTE_MS);
        const msg = `Bilge pump running continuously for ${runningMin} minutes (limit: ${config.longCycleDurationMinutes}min). Check bilge!`;
        sendNotification('bilge.longCycle', msg, 'alarm', ['visual', 'sound']);
        app.debug(msg);
      }
    }
  }

  // ── Publish cycle data to SignalK ──────────────────────────────────────────

  function publishData() {
    pruneCycles();

    const count1h = countCyclesInWindow(HOUR_MS);
    const count24h = countCyclesInWindow(DAY_MS);
    const freq = count1h; // cycles per hour (based on last 1h window)
    const runtime1h = runtimeInWindow(HOUR_MS);
    const runtime24h = runtimeInWindow(DAY_MS);

    sendDelta('electrical.bilge.cycleCount.1h', count1h);
    sendDelta('electrical.bilge.cycleCount.24h', count24h);
    sendDelta('electrical.bilge.frequency', freq);
    sendDelta('electrical.bilge.runtime.1h', Math.round(runtime1h / 1000));       // seconds
    sendDelta('electrical.bilge.runtime.24h', Math.round(runtime24h / 1000));      // seconds
    sendDelta('electrical.bilge.runtime.dailyTotal', Math.round(totalDailyRuntimeMs / 1000)); // seconds
    sendDelta('electrical.bilge.pumpState', pumpOn ? 1 : 0);

    // Last cycle duration (if any cycles exist)
    if (cycles.length > 0) {
      const last = cycles[cycles.length - 1];
      sendDelta('electrical.bilge.lastCycleDuration', Math.round(last.durationMs / 1000)); // seconds
    }

    // Current cycle runtime if pump is running
    if (pumpOn && cycleStartTime) {
      const currentRuntime = Date.now() - cycleStartTime;
      sendDelta('electrical.bilge.currentCycleRuntime', Math.round(currentRuntime / 1000)); // seconds
    }
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  function postWebhook(message, frequency) {
    if (!config.webhookUrl) return;

    const now = Date.now();
    const cooldownMs = config.webhookCooldownMinutes * MINUTE_MS;
    if (now - lastWebhookTime < cooldownMs) {
      app.debug('Webhook cooldown active, skipping');
      return;
    }
    lastWebhookTime = now;

    const payload = JSON.stringify({
      plugin: plugin.id,
      event: 'highFrequency',
      message: message,
      frequency: frequency,
      threshold: config.frequencyAlarmThreshold,
      cycleCount1h: countCyclesInWindow(HOUR_MS),
      cycleCount24h: countCyclesInWindow(DAY_MS),
      dailyRuntimeSeconds: Math.round(totalDailyRuntimeMs / 1000),
      timestamp: new Date().toISOString()
    });

    const parsed = url.parse(config.webhookUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = transport.request(reqOptions, (res) => {
      app.debug('Webhook response: %d', res.statusCode);
    });

    req.on('error', (err) => {
      app.error('Bilge webhook error: ' + err.message);
    });

    req.write(payload);
    req.end();
  }

  // ── Midnight reset ─────────────────────────────────────────────────────────

  function checkMidnightReset() {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (lastDateStr === null) {
      lastDateStr = todayStr;
      return;
    }
    if (todayStr !== lastDateStr) {
      app.debug(
        'Midnight reset — yesterday runtime: %ds, cycles: %d',
        Math.round(totalDailyRuntimeMs / 1000),
        countCyclesInWindow(DAY_MS)
      );
      totalDailyRuntimeMs = 0;
      lastDateStr = todayStr;
    }
  }

  // ── Subscribe to SignalK paths ─────────────────────────────────────────────

  function subscribe() {
    const pumpPath = config.pumpPath;

    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          {
            path: pumpPath,
            period: 1000
          }
        ]
      },
      unsubscribes,
      (subscriptionError) => {
        app.error('Bilge Monitor: subscription error: ' + subscriptionError);
      },
      (delta) => {
        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (update.values) {
              update.values.forEach((pathValue) => {
                if (pathValue.path === pumpPath) {
                  handlePumpState(pathValue.value);
                }
              });
            }
          });
        }
      }
    );
  }

  // ── Plugin lifecycle ───────────────────────────────────────────────────────

  plugin.start = function (options) {
    config = Object.assign(
      {
        pumpPath: 'electrical.switches.bilgePump.state',
        frequencyAlarmThreshold: 4,
        longCycleDurationMinutes: 5,
        publishIntervalSeconds: 10,
        webhookUrl: '',
        webhookCooldownMinutes: 15
      },
      options
    );

    app.debug('Bilge Monitor starting with config: %j', config);

    subscribe();

    // Main processing loop
    const publishInterval = setInterval(() => {
      checkMidnightReset();
      publishData();
      checkAlerts();
    }, config.publishIntervalSeconds * 1000);
    intervals.push(publishInterval);

    app.setPluginStatus('Running');
  };

  plugin.stop = function () {
    unsubscribes.forEach((unsub) => unsub());
    unsubscribes = [];
    intervals.forEach((iv) => clearInterval(iv));
    intervals = [];

    // Reset state
    pumpOn = false;
    cycleStartTime = null;
    cycles = [];
    totalDailyRuntimeMs = 0;
    lastDateStr = null;
    highFrequencyAlertActive = false;
    longCycleAlertActive = false;
    lastWebhookTime = 0;

    app.setPluginStatus('Stopped');
  };

  return plugin;
};
