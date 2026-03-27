'use strict';

const https = require('https');
const http = require('http');

const DEFAULT_INTERVAL_S = 600; // 10 minutes
const RETRY_DELAY_MS = 30000;   // 30 seconds on failure
const MAX_RETRIES = 3;

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-floatilla-weather-overlay';
  plugin.name = 'Weather Overlay';
  plugin.description =
    'Fetches weather forecast data from Open-Meteo and publishes it as SignalK environment paths';

  let fetchTimer = null;
  let retryTimer = null;
  let running = false;
  let config = {};

  // ── Schema ─────────────────────────────────────────────────────────────────
  plugin.schema = {
    type: 'object',
    title: 'Weather Overlay Configuration',
    properties: {
      updateIntervalSeconds: {
        type: 'number',
        title: 'Update interval (seconds)',
        description: 'How often to fetch fresh weather data from Open-Meteo',
        default: DEFAULT_INTERVAL_S
      }
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getVesselPosition() {
    const pos = app.getSelfPath('navigation.position');
    if (pos && pos.value && typeof pos.value.latitude === 'number' && typeof pos.value.longitude === 'number') {
      return { lat: pos.value.latitude, lon: pos.value.longitude };
    }
    return null;
  }

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      const driver = url.startsWith('https') ? https : http;
      driver.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          res.resume();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Invalid JSON from Open-Meteo'));
          }
        });
      }).on('error', reject);
    });
  }

  function degreesToRadians(deg) {
    return (deg * Math.PI) / 180;
  }

  function kphToMs(kph) {
    return kph / 3.6;
  }

  function publishDelta(values) {
    const delta = {
      updates: [
        {
          source: {
            label: plugin.id,
            type: 'forecast',
            src: 'open-meteo'
          },
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    };
    app.handleMessage(plugin.id, delta);
  }

  // ── Fetch & publish ────────────────────────────────────────────────────────

  async function fetchWeather(retryCount) {
    if (!running) return;

    const pos = getVesselPosition();
    if (!pos) {
      app.debug('No vessel position available, skipping weather fetch');
      return;
    }

    const params = [
      `latitude=${pos.lat}`,
      `longitude=${pos.lon}`,
      'current=windspeed_10m,winddirection_10m,windgusts_10m,precipitation,wave_height,wave_direction,weathercode',
      'windspeed_unit=kmh'
    ].join('&');

    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    try {
      const data = await httpGet(url);

      const current = data.current || data.current_weather || {};

      const values = [];

      if (typeof current.windspeed_10m === 'number') {
        values.push({
          path: 'environment.wind.speedOverGround',
          value: kphToMs(current.windspeed_10m)
        });
      }

      if (typeof current.winddirection_10m === 'number') {
        values.push({
          path: 'environment.wind.directionTrue',
          value: degreesToRadians(current.winddirection_10m)
        });
      }

      if (typeof current.windgusts_10m === 'number') {
        values.push({
          path: 'environment.wind.gustSpeed',
          value: kphToMs(current.windgusts_10m)
        });
      }

      if (typeof current.wave_height === 'number') {
        values.push({
          path: 'environment.water.waves.significantHeight',
          value: current.wave_height // already in metres
        });
      }

      if (typeof current.precipitation === 'number') {
        values.push({
          path: 'environment.outside.precipitationRate',
          value: current.precipitation // mm/h
        });
      }

      if (typeof current.weathercode === 'number') {
        values.push({
          path: 'environment.outside.weatherCode',
          value: current.weathercode
        });
      }

      if (values.length > 0) {
        publishDelta(values);
        app.debug(`Weather updated: ${values.length} values from Open-Meteo (${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)})`);
      }

    } catch (err) {
      app.error(`Weather fetch failed: ${err.message}`);
      const attempt = retryCount || 0;
      if (attempt < MAX_RETRIES && running) {
        app.debug(`Retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        retryTimer = setTimeout(() => fetchWeather(attempt + 1), RETRY_DELAY_MS);
      }
    }
  }

  // ── Plugin lifecycle ───────────────────────────────────────────────────────

  plugin.start = function (options) {
    config = options || {};
    running = true;

    const intervalMs = (config.updateIntervalSeconds || DEFAULT_INTERVAL_S) * 1000;

    app.debug(`Starting weather overlay, interval ${intervalMs / 1000}s`);

    // Fetch immediately, then on interval
    fetchWeather(0);
    fetchTimer = setInterval(() => fetchWeather(0), intervalMs);
  };

  plugin.stop = function () {
    running = false;
    if (fetchTimer) {
      clearInterval(fetchTimer);
      fetchTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    app.debug('Weather overlay stopped');
  };

  return plugin;
};
