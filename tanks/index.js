'use strict';

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-floatilla-tanks';
  plugin.name = 'Floatilla Tanks';
  plugin.description =
    'Tank monitoring with fill rate, usage tracking and time-to-empty estimation';

  // ── State ──────────────────────────────────────────────────────────────────
  let config = {};
  let unsubscribes = [];
  let intervals = [];

  // Tank types we monitor
  const TANK_TYPES = ['fuel', 'freshWater', 'blackWater'];

  // Per-tank state: { history: [{t, value}], currentLevel: null, alertActive: false }
  let tankState = {};

  // ── Schema ─────────────────────────────────────────────────────────────────
  plugin.schema = {
    type: 'object',
    title: 'Floatilla Tank Monitor Configuration',
    properties: {
      rateWindow: {
        type: 'number',
        title: 'Rate calculation window (seconds)',
        description:
          'Time window in seconds over which fill/usage rates are calculated',
        default: 60
      },
      publishInterval: {
        type: 'number',
        title: 'Publish interval (seconds)',
        description: 'How often to publish computed values',
        default: 10
      },
      fuelLowThreshold: {
        type: 'number',
        title: 'Fuel low threshold (ratio 0-1)',
        description: 'Below this level a low-fuel notification is sent',
        default: 0.15
      },
      freshWaterLowThreshold: {
        type: 'number',
        title: 'Fresh water low threshold (ratio 0-1)',
        description: 'Below this level a low-water notification is sent',
        default: 0.2
      },
      blackWaterLowThreshold: {
        type: 'number',
        title: 'Black water high threshold (ratio 0-1)',
        description: 'Above this level a black-water-full notification is sent',
        default: 0.85
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

  function tankPath(tankType) {
    return 'tanks.' + tankType + '.0';
  }

  function pruneHistory(arr, maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
  }

  // Calculate rate of change over the configured window.
  // Returns ratio-per-second (positive = filling, negative = draining).
  function calculateRate(history) {
    if (history.length < 2) return null;

    const windowMs = (config.rateWindow || 60) * 1000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const relevant = history.filter(function (p) {
      return p.t >= cutoff;
    });

    if (relevant.length < 2) return null;

    const first = relevant[0];
    const last = relevant[relevant.length - 1];
    const dt = (last.t - first.t) / 1000; // seconds

    if (dt < 1) return null;

    return (last.value - first.value) / dt; // ratio per second
  }

  // ── Computed values ────────────────────────────────────────────────────────

  function publishComputed() {
    TANK_TYPES.forEach(function (tankType) {
      var state = tankState[tankType];
      if (!state || state.currentLevel === null) return;

      var rate = calculateRate(state.history);
      var basePath = tankPath(tankType);

      // Usage rate: magnitude of decrease (ratio per second, always >= 0)
      var usageRate = 0;
      if (rate !== null && rate < 0) {
        usageRate = Math.abs(rate);
      }
      sendDelta(basePath + '.usageRate', usageRate);

      // Fill rate: published as the raw rate (positive = filling, negative = draining)
      if (rate !== null) {
        sendDelta(basePath + '.fillRate', rate);
      }

      // Time to empty (seconds). Only meaningful when level is decreasing.
      if (usageRate > 0) {
        var timeToEmpty = state.currentLevel / usageRate;
        sendDelta(basePath + '.timeToEmpty', timeToEmpty);
      } else {
        sendDelta(basePath + '.timeToEmpty', null);
      }
    });
  }

  // ── Alarms ─────────────────────────────────────────────────────────────────

  function checkAlarms() {
    TANK_TYPES.forEach(function (tankType) {
      var state = tankState[tankType];
      if (!state || state.currentLevel === null) return;

      var level = state.currentLevel;
      var notifPath = 'tanks.' + tankType + '.low';
      var shouldAlarm = false;
      var message = '';

      if (tankType === 'blackWater') {
        // Black water: alarm when HIGH (nearly full)
        var threshold = config.blackWaterLowThreshold || 0.85;
        shouldAlarm = level >= threshold;
        message =
          'Black water tank nearly full: ' +
          (level * 100).toFixed(0) +
          '%';
        notifPath = 'tanks.blackWater.high';
      } else {
        var thresholdKey = tankType + 'LowThreshold';
        var thresh = config[thresholdKey] || 0.15;
        shouldAlarm = level <= thresh;

        var label = tankType === 'fuel' ? 'Fuel' : 'Fresh water';
        message =
          label +
          ' tank low: ' +
          (level * 100).toFixed(0) +
          '%';
      }

      if (shouldAlarm && !state.alertActive) {
        state.alertActive = true;
        sendNotification(
          notifPath,
          message,
          tankType === 'fuel' ? 'warn' : 'alert',
          ['visual', 'sound']
        );
      } else if (!shouldAlarm && state.alertActive) {
        state.alertActive = false;
        clearNotification(notifPath);
      }
    });
  }

  // ── Subscribe to SignalK paths ─────────────────────────────────────────────

  function subscribe() {
    var subscriptions = [];
    var windowMs = (config.rateWindow || 60) * 1000;
    // Keep 2x the window to ensure we always have enough data
    var keepMs = windowMs * 2;

    TANK_TYPES.forEach(function (tankType) {
      var skPath = tankPath(tankType) + '.currentLevel';

      subscriptions.push({
        path: skPath,
        tankType: tankType,
        handle: function (value) {
          if (typeof value !== 'number') return;
          var state = tankState[tankType];
          state.currentLevel = value;
          state.history.push({ t: Date.now(), value: value });
          pruneHistory(state.history, keepMs);
        }
      });
    });

    var localSubs = subscriptions.map(function (sub) {
      return { path: sub.path, period: 1000 };
    });

    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: localSubs
      },
      unsubscribes,
      function (subscriptionError) {
        app.error('Floatilla Tanks: subscription error: ' + subscriptionError);
      },
      function (delta) {
        if (delta.updates) {
          delta.updates.forEach(function (update) {
            if (update.values) {
              update.values.forEach(function (pathValue) {
                var sub = subscriptions.find(function (s) {
                  return s.path === pathValue.path;
                });
                if (sub) sub.handle(pathValue.value);
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
        rateWindow: 60,
        publishInterval: 10,
        fuelLowThreshold: 0.15,
        freshWaterLowThreshold: 0.2,
        blackWaterLowThreshold: 0.85
      },
      options
    );

    app.debug('Floatilla Tanks starting with config: %j', config);

    // Initialize per-tank state
    tankState = {};
    TANK_TYPES.forEach(function (tankType) {
      tankState[tankType] = {
        history: [],
        currentLevel: null,
        alertActive: false
      };
    });

    // Subscribe to tank level paths
    subscribe();

    // Main processing loop
    var publishMs = (config.publishInterval || 10) * 1000;
    var mainInterval = setInterval(function () {
      publishComputed();
      checkAlarms();
    }, publishMs);
    intervals.push(mainInterval);

    app.setPluginStatus('Running');
  };

  plugin.stop = function () {
    unsubscribes.forEach(function (unsub) {
      unsub();
    });
    unsubscribes = [];
    intervals.forEach(function (iv) {
      clearInterval(iv);
    });
    intervals = [];

    tankState = {};

    app.setPluginStatus('Stopped');
  };

  return plugin;
};
