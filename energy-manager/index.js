'use strict';

const SunCalc = require('suncalc');
const fs = require('fs');
const path = require('path');

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const DAY_MS = 86400000;

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-energy-manager';
  plugin.name = 'Energy Manager';
  plugin.description =
    'Intelligent energy management — monitors batteries, solar, shore power and performs smart charging actions';

  // ── State ──────────────────────────────────────────────────────────────────
  let config = {};
  let unsubscribes = [];
  let intervals = [];

  // Rolling history buffers
  let socHistory = [];        // { t, value } — kept up to 30 days
  let powerHistory = [];      // { t, value } W — kept up to 24h for consumption rate
  let solarPowerHistory = []; // { t, value } W — kept up to 24h

  // Daily energy accumulators (reset at midnight)
  let dailyConsumedWh = 0;
  let dailySolarWh = 0;
  let lastEnergyTickTime = null;

  // Latest instantaneous values
  let currentSoC = null;          // 0-1 ratio
  let currentBatteryPower = null; // W (positive = discharging, negative = charging)
  let currentBatteryVoltage = null;
  let currentBatteryCurrent = null;
  let currentSolarPower = 0;      // W total across all panels
  let currentShorePower = null;   // W (null if not connected)
  let currentAlternatorPower = null;

  let position = null; // { latitude, longitude }

  // Persisted history (loaded/saved to disk)
  let dailyHistory = []; // [{ date: 'YYYY-MM-DD', consumedWh, solarWh, avgSoC }]

  // ── Schema ─────────────────────────────────────────────────────────────────
  plugin.schema = {
    type: 'object',
    title: 'Energy Manager Configuration',
    properties: {
      batteryPath: {
        type: 'string',
        title: 'Battery base path',
        description: 'SignalK path prefix for the main battery bank',
        default: 'electrical.batteries.house'
      },
      solarPaths: {
        type: 'array',
        title: 'Solar power paths',
        description: 'SignalK paths that report solar charger power (W)',
        items: { type: 'string' },
        default: ['electrical.solar.1.panelPower']
      },
      shorePowerPath: {
        type: 'string',
        title: 'Shore power path (read)',
        description: 'SignalK path for shore/AC input power (W)',
        default: 'electrical.ac.shore.power'
      },
      shorePowerLimitPath: {
        type: 'string',
        title: 'Shore power limit PUT path',
        description:
          'SignalK path to PUT shore current limit (A). Leave empty to disable shore power control.',
        default: ''
      },
      alternatorPath: {
        type: 'string',
        title: 'Alternator power path',
        description: 'SignalK path for alternator power (W). Leave empty if not available.',
        default: ''
      },
      shoreCurrentMin: {
        type: 'number',
        title: 'Shore current min (A)',
        description: 'Minimum shore amps when SoC is high',
        default: 6
      },
      shoreCurrentMax: {
        type: 'number',
        title: 'Shore current max (A)',
        description: 'Maximum shore amps for boost charging',
        default: 32
      },
      socHighThreshold: {
        type: 'number',
        title: 'SoC high threshold (%)',
        description: 'Above this SoC, reduce shore power',
        default: 90
      },
      socLowThreshold: {
        type: 'number',
        title: 'SoC low threshold (%)',
        description: 'Below this SoC, boost shore power',
        default: 30
      },
      socCritical: {
        type: 'number',
        title: 'SoC critical threshold (%)',
        description: 'Below this SoC, trigger critical alert',
        default: 15
      },
      solarPanelWp: {
        type: 'number',
        title: 'Total solar panel Wp',
        description: 'Total installed solar capacity in watts-peak (for efficiency calc)',
        default: 400
      },
      batteryCapacityWh: {
        type: 'number',
        title: 'Battery capacity (Wh)',
        description: 'Total battery capacity in watt-hours (for time estimates)',
        default: 5000
      },
      historyDir: {
        type: 'string',
        title: 'History data directory',
        description: 'Directory to persist daily energy history',
        default: ''
      }
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getHistoryDir() {
    if (config.historyDir) return config.historyDir;
    const skDir =
      app.config && app.config.configPath
        ? app.config.configPath
        : path.join(require('os').homedir(), '.signalk');
    return path.join(skDir, 'energy-history');
  }

  function ensureHistoryDir() {
    const dir = getHistoryDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function loadHistory() {
    try {
      const file = path.join(getHistoryDir(), 'daily.json');
      if (fs.existsSync(file)) {
        dailyHistory = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Trim to 30 days
        const cutoff = Date.now() - 30 * DAY_MS;
        dailyHistory = dailyHistory.filter(
          (d) => new Date(d.date).getTime() > cutoff
        );
      }
    } catch (e) {
      app.error('Energy Manager: failed to load history: ' + e.message);
    }
  }

  function saveHistory() {
    try {
      ensureHistoryDir();
      const file = path.join(getHistoryDir(), 'daily.json');
      fs.writeFileSync(file, JSON.stringify(dailyHistory, null, 2));
    } catch (e) {
      app.error('Energy Manager: failed to save history: ' + e.message);
    }
  }

  function pruneTimeSeries(arr, maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
  }

  function avgOverWindow(arr, windowMs) {
    const cutoff = Date.now() - windowMs;
    const relevant = arr.filter((p) => p.t >= cutoff);
    if (relevant.length === 0) return null;
    return relevant.reduce((s, p) => s + p.value, 0) / relevant.length;
  }

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

  // ── Solar theoretical calculation ──────────────────────────────────────────

  function getTheoreticalSolarPower() {
    if (!position || !config.solarPanelWp) return null;

    const now = new Date();
    const sunPos = SunCalc.getPosition(now, position.latitude, position.longitude);
    const altitudeDeg = (sunPos.altitude * 180) / Math.PI;

    if (altitudeDeg <= 0) return 0; // Sun below horizon

    // Simple clear-sky model: power proportional to sin(altitude)
    // with atmospheric attenuation factor (~0.7 for clear sky at sea level)
    const atmosphericFactor = 0.7;
    const sinAltitude = Math.sin(sunPos.altitude);

    // Air mass approximation (Kasten & Young)
    const airMass =
      1 / (sinAltitude + 0.50572 * Math.pow(96.07995 - (90 - altitudeDeg), -1.6364));
    const clearSkyTransmittance = Math.pow(atmosphericFactor, airMass);

    return config.solarPanelWp * sinAltitude * clearSkyTransmittance;
  }

  // ── Detect active charging source ──────────────────────────────────────────

  function detectChargingSource() {
    const sources = [];
    if (currentSolarPower > 10) sources.push('solar');
    if (currentShorePower !== null && currentShorePower > 10) sources.push('shore');
    if (currentAlternatorPower !== null && currentAlternatorPower > 10)
      sources.push('alternator');
    return sources.length > 0 ? sources : ['none'];
  }

  // ── Shore power control ────────────────────────────────────────────────────

  let lastShoreControlTime = 0;

  function controlShorePower() {
    if (!config.shorePowerLimitPath) return;
    if (currentSoC === null) return;
    if (currentShorePower === null || currentShorePower < 1) return; // Shore not connected

    const now = Date.now();
    // Debounce: don't adjust more often than every 60 seconds
    if (now - lastShoreControlTime < MINUTE_MS) return;

    const socPct = currentSoC * 100;
    let targetAmps = null;

    if (socPct >= config.socHighThreshold) {
      targetAmps = config.shoreCurrentMin;
      app.debug('SoC %.1f%% >= %d%%, reducing shore to %dA', socPct, config.socHighThreshold, targetAmps);
    } else if (socPct <= config.socLowThreshold) {
      targetAmps = config.shoreCurrentMax;
      app.debug('SoC %.1f%% <= %d%%, boosting shore to %dA', socPct, config.socLowThreshold, targetAmps);
    }

    if (targetAmps !== null) {
      lastShoreControlTime = now;
      app.putSelfPath(config.shorePowerLimitPath, targetAmps, (result) => {
        if (result.state === 'COMPLETED') {
          app.debug('Shore power limit set to %dA', targetAmps);
        } else {
          app.error('Energy Manager: PUT shore power failed: ' + JSON.stringify(result));
        }
      });
    }
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  let alertStates = {
    highConsumption: false,
    solarUnderperforming: false,
    batteryDegradation: false,
    socCritical: false
  };

  function checkAlerts() {
    // Critical SoC
    if (currentSoC !== null) {
      const socPct = currentSoC * 100;
      if (socPct <= config.socCritical && !alertStates.socCritical) {
        alertStates.socCritical = true;
        sendNotification(
          'energy.batteryCritical',
          `Battery SoC critically low: ${socPct.toFixed(1)}%`,
          'emergency',
          ['visual', 'sound']
        );
      } else if (socPct > config.socCritical + 5 && alertStates.socCritical) {
        alertStates.socCritical = false;
        clearNotification('energy.batteryCritical');
      }
    }

    // High consumption rate
    const avgPower15m = avgOverWindow(powerHistory, 15 * MINUTE_MS);
    if (avgPower15m !== null) {
      const highThresholdW = (config.batteryCapacityWh || 5000) * 0.2; // 20% of capacity / hour = high
      if (avgPower15m > highThresholdW && !alertStates.highConsumption) {
        alertStates.highConsumption = true;
        sendNotification(
          'energy.highConsumption',
          `High power consumption detected: ${avgPower15m.toFixed(0)}W average over 15min`,
          'warn',
          ['visual']
        );
      } else if (avgPower15m <= highThresholdW * 0.8 && alertStates.highConsumption) {
        alertStates.highConsumption = false;
        clearNotification('energy.highConsumption');
      }
    }

    // Solar underperforming
    const theoretical = getTheoreticalSolarPower();
    if (
      theoretical !== null &&
      theoretical > 50 &&
      currentSolarPower > 0
    ) {
      const efficiency = currentSolarPower / theoretical;
      if (efficiency < 0.5 && !alertStates.solarUnderperforming) {
        alertStates.solarUnderperforming = true;
        sendNotification(
          'energy.solarUnderperforming',
          `Solar underperforming: ${(efficiency * 100).toFixed(0)}% of theoretical max (${theoretical.toFixed(0)}W)`,
          'warn',
          ['visual']
        );
      } else if (efficiency >= 0.5 && alertStates.solarUnderperforming) {
        alertStates.solarUnderperforming = false;
        clearNotification('energy.solarUnderperforming');
      }
    }

    // Battery degradation — compare recent avg daily consumption with older
    if (dailyHistory.length >= 14) {
      const recent7 = dailyHistory.slice(-7);
      const older7 = dailyHistory.slice(-14, -7);
      const avgRecentSoC = recent7.reduce((s, d) => s + (d.avgSoC || 0), 0) / 7;
      const avgOlderSoC = older7.reduce((s, d) => s + (d.avgSoC || 0), 0) / 7;
      // If avg SoC dropped by more than 15 points with similar consumption, flag degradation
      const avgRecentConsumption = recent7.reduce((s, d) => s + d.consumedWh, 0) / 7;
      const avgOlderConsumption = older7.reduce((s, d) => s + d.consumedWh, 0) / 7;
      const consumptionRatio =
        avgOlderConsumption > 0
          ? avgRecentConsumption / avgOlderConsumption
          : 1;

      if (
        avgOlderSoC - avgRecentSoC > 15 &&
        consumptionRatio < 1.2 &&
        !alertStates.batteryDegradation
      ) {
        alertStates.batteryDegradation = true;
        sendNotification(
          'energy.batteryDegradation',
          'Possible battery capacity degradation detected: average SoC declining despite similar consumption patterns',
          'warn',
          ['visual']
        );
      } else if (
        avgOlderSoC - avgRecentSoC <= 10 &&
        alertStates.batteryDegradation
      ) {
        alertStates.batteryDegradation = false;
        clearNotification('energy.batteryDegradation');
      }
    }
  }

  // ── Publish derived data ───────────────────────────────────────────────────

  function publishDerived() {
    // Consumption rate (15 min rolling average)
    const avgPower15m = avgOverWindow(powerHistory, 15 * MINUTE_MS);
    if (avgPower15m !== null) {
      sendDelta('electrical.batteries.main.capacity.consumptionRate', avgPower15m);
    }

    // Estimated time to empty (hours)
    if (avgPower15m !== null && avgPower15m > 0 && currentSoC !== null) {
      const remainingWh = currentSoC * (config.batteryCapacityWh || 5000);
      const hoursToEmpty = remainingWh / avgPower15m;
      sendDelta(
        'electrical.batteries.main.capacity.estimatedTimeToEmpty',
        Math.max(0, hoursToEmpty)
      );
    }

    // Estimated time to full (hours)
    if (currentBatteryPower !== null && currentBatteryPower < -10 && currentSoC !== null) {
      const remainingWh = (1 - currentSoC) * (config.batteryCapacityWh || 5000);
      const chargePowerW = Math.abs(currentBatteryPower);
      const hoursToFull = remainingWh / chargePowerW;
      sendDelta(
        'electrical.batteries.main.capacity.estimatedTimeToFull',
        Math.max(0, hoursToFull)
      );
    }

    // Solar efficiency
    const theoretical = getTheoreticalSolarPower();
    if (theoretical !== null && theoretical > 0) {
      const efficiency = Math.min(1, currentSolarPower / theoretical);
      sendDelta('electrical.solar.efficiency', efficiency);
    }

    // Daily energy totals
    sendDelta('electrical.energyToday.consumed', dailyConsumedWh);
    sendDelta('electrical.energyToday.solar', dailySolarWh);

    // Charging sources
    sendDelta('electrical.charging.activeSources', detectChargingSource());
  }

  // ── Energy accumulation ────────────────────────────────────────────────────

  function accumulateEnergy() {
    const now = Date.now();
    if (lastEnergyTickTime === null) {
      lastEnergyTickTime = now;
      return;
    }

    const dtHours = (now - lastEnergyTickTime) / HOUR_MS;
    lastEnergyTickTime = now;

    // Battery discharge → consumed energy
    if (currentBatteryPower !== null && currentBatteryPower > 0) {
      dailyConsumedWh += currentBatteryPower * dtHours;
    }

    // Solar production
    if (currentSolarPower > 0) {
      dailySolarWh += currentSolarPower * dtHours;
    }
  }

  // ── Midnight reset ─────────────────────────────────────────────────────────

  let lastDateStr = null;

  function checkMidnightReset() {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (lastDateStr === null) {
      lastDateStr = todayStr;
      return;
    }
    if (todayStr !== lastDateStr) {
      // Save yesterday's summary
      const avgSoC =
        socHistory.length > 0
          ? socHistory.reduce((s, p) => s + p.value, 0) / socHistory.length
          : null;

      dailyHistory.push({
        date: lastDateStr,
        consumedWh: Math.round(dailyConsumedWh),
        solarWh: Math.round(dailySolarWh),
        avgSoC: avgSoC !== null ? Math.round(avgSoC * 1000) / 10 : null
      });

      // Trim to 30 days
      if (dailyHistory.length > 30) {
        dailyHistory = dailyHistory.slice(-30);
      }

      saveHistory();

      // Reset accumulators
      dailyConsumedWh = 0;
      dailySolarWh = 0;
      lastDateStr = todayStr;
      app.debug('Midnight reset — new day: %s', todayStr);
    }
  }

  // ── Subscribe to SignalK paths ─────────────────────────────────────────────

  function subscribe() {
    const subscriptions = [];
    const batteryBase = config.batteryPath || 'electrical.batteries.house';

    // Battery SoC
    subscriptions.push({
      path: batteryBase + '.capacity.stateOfCharge',
      handle: (value) => {
        if (typeof value === 'number') {
          currentSoC = value; // SignalK SoC is 0-1 ratio
          socHistory.push({ t: Date.now(), value: value });
          pruneTimeSeries(socHistory, 30 * DAY_MS);
        }
      }
    });

    // Battery voltage
    subscriptions.push({
      path: batteryBase + '.voltage',
      handle: (value) => {
        if (typeof value === 'number') currentBatteryVoltage = value;
      }
    });

    // Battery current
    subscriptions.push({
      path: batteryBase + '.current',
      handle: (value) => {
        if (typeof value === 'number') {
          currentBatteryCurrent = value;
          // Compute power: V × I (positive current = discharge in SignalK convention varies,
          // we'll use absolute and determine sign from current direction)
          if (currentBatteryVoltage !== null) {
            // Positive current = discharging from battery perspective
            currentBatteryPower = currentBatteryVoltage * value;
            powerHistory.push({
              t: Date.now(),
              value: Math.max(0, currentBatteryPower) // Only track discharge for consumption
            });
            pruneTimeSeries(powerHistory, 24 * HOUR_MS);
          }
        }
      }
    });

    // Solar paths
    const solarPaths = config.solarPaths || ['electrical.solar.1.panelPower'];
    const solarValues = {};
    solarPaths.forEach((sp) => {
      solarValues[sp] = 0;
      subscriptions.push({
        path: sp,
        handle: (value) => {
          if (typeof value === 'number') {
            solarValues[sp] = value;
            currentSolarPower = Object.values(solarValues).reduce(
              (s, v) => s + v,
              0
            );
            solarPowerHistory.push({ t: Date.now(), value: currentSolarPower });
            pruneTimeSeries(solarPowerHistory, 24 * HOUR_MS);
          }
        }
      });
    });

    // Shore power
    if (config.shorePowerPath) {
      subscriptions.push({
        path: config.shorePowerPath,
        handle: (value) => {
          currentShorePower = typeof value === 'number' ? value : null;
        }
      });
    }

    // Alternator
    if (config.alternatorPath) {
      subscriptions.push({
        path: config.alternatorPath,
        handle: (value) => {
          currentAlternatorPower = typeof value === 'number' ? value : null;
        }
      });
    }

    // GPS position
    subscriptions.push({
      path: 'navigation.position',
      handle: (value) => {
        if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
          position = { latitude: value.latitude, longitude: value.longitude };
        }
      }
    });

    // Register subscriptions via SignalK stream API
    const localSubs = subscriptions.map((sub) => {
      return {
        path: sub.path,
        period: 5000
      };
    });

    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: localSubs
      },
      unsubscribes,
      (subscriptionError) => {
        app.error('Energy Manager: subscription error: ' + subscriptionError);
      },
      (delta) => {
        if (delta.updates) {
          delta.updates.forEach((update) => {
            if (update.values) {
              update.values.forEach((pathValue) => {
                const sub = subscriptions.find((s) => s.path === pathValue.path);
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
        batteryPath: 'electrical.batteries.house',
        solarPaths: ['electrical.solar.1.panelPower'],
        shorePowerPath: 'electrical.ac.shore.power',
        shorePowerLimitPath: '',
        alternatorPath: '',
        shoreCurrentMin: 6,
        shoreCurrentMax: 32,
        socHighThreshold: 90,
        socLowThreshold: 30,
        socCritical: 15,
        solarPanelWp: 400,
        batteryCapacityWh: 5000,
        historyDir: ''
      },
      options
    );

    app.debug('Energy Manager starting with config: %j', config);

    // Load persisted history
    loadHistory();

    // Subscribe to data paths
    subscribe();

    // Main processing loop — every 10 seconds
    const mainInterval = setInterval(() => {
      accumulateEnergy();
      checkMidnightReset();
      publishDerived();
      checkAlerts();
      controlShorePower();
    }, 10000);
    intervals.push(mainInterval);

    // Periodic history save — every 5 minutes
    const saveInterval = setInterval(() => {
      saveHistory();
    }, 5 * MINUTE_MS);
    intervals.push(saveInterval);

    app.setPluginStatus('Running');
  };

  plugin.stop = function () {
    unsubscribes.forEach((unsub) => unsub());
    unsubscribes = [];
    intervals.forEach((iv) => clearInterval(iv));
    intervals = [];

    // Save on stop
    saveHistory();

    // Reset state
    socHistory = [];
    powerHistory = [];
    solarPowerHistory = [];
    dailyConsumedWh = 0;
    dailySolarWh = 0;
    lastEnergyTickTime = null;
    currentSoC = null;
    currentBatteryPower = null;
    currentBatteryVoltage = null;
    currentBatteryCurrent = null;
    currentSolarPower = 0;
    currentShorePower = null;
    currentAlternatorPower = null;
    position = null;
    lastShoreControlTime = 0;
    alertStates = {
      highConsumption: false,
      solarUnderperforming: false,
      batteryDegradation: false,
      socCritical: false
    };

    app.setPluginStatus('Stopped');
  };

  return plugin;
};
