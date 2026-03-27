'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-notify';
  plugin.name = 'SignalK Notify';
  plugin.description =
    'Send vessel status notifications and alerts via webhooks (Discord, Telegram, Slack, generic HTTP).';

  let digestTimer = null;
  let alertSubscriptions = [];
  let alertCooldowns = {};
  let solarEnergyYesterday = 0;
  let solarEnergyTodayStart = 0;
  let lastSolarResetDay = null;

  // ── helpers ──────────────────────────────────────────────────────────

  function getPath(path) {
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

  function getSelfPath(path) {
    try {
      return app.getSelfPath(path);
    } catch (_) {
      return getPath(path);
    }
  }

  function getTimezone(options) {
    return options.timezone || 'UTC';
  }

  function nowInTimezone(tz) {
    return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  }

  function formatDate(date, tz) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const d = new Date(date.toLocaleString('en-US', { timeZone: tz }));
    const day = days[d.getDay()];
    const dd = d.getDate();
    const mon = months[d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${dd} ${mon} ${hh}:${mm}`;
  }

  function pct(v) {
    if (v == null) return null;
    return Math.round(v * 100);
  }

  function round1(v) {
    if (v == null) return null;
    return Math.round(v * 10) / 10;
  }

  // ── data collection ──────────────────────────────────────────────────

  function collectBattery() {
    const soc = getSelfPath('electrical.batteries.house.capacity.stateOfCharge');
    const voltage = getSelfPath('electrical.batteries.house.voltage');
    const current = getSelfPath('electrical.batteries.house.current');

    let state = 'idle';
    if (current != null) {
      if (current > 0.5) state = 'charging';
      else if (current < -0.5) state = 'discharging';
    }

    // detect shore power
    const shoreConnected = getSelfPath('electrical.ac.shore.state');
    let stateLabel = state;
    if (state === 'charging' && shoreConnected) {
      stateLabel = 'Charging (shore power)';
    } else {
      stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
    }

    return {
      socRatio: soc,
      socPct: pct(soc),
      voltage: round1(voltage),
      current: round1(current),
      state,
      stateLabel,
    };
  }

  function collectSolar() {
    const totalEnergy = getSelfPath('electrical.solar.panelPower');
    const lifetimeEnergy = getSelfPath('electrical.solar.lifetimeEnergy');

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (lastSolarResetDay && lastSolarResetDay !== today) {
      if (lifetimeEnergy != null) {
        solarEnergyYesterday =
          (lifetimeEnergy - solarEnergyTodayStart) / 3600000; // J → kWh
        solarEnergyTodayStart = lifetimeEnergy;
      }
    }
    if (!lastSolarResetDay) {
      solarEnergyTodayStart = lifetimeEnergy || 0;
    }
    lastSolarResetDay = today;

    let todayKwh = 0;
    if (lifetimeEnergy != null) {
      todayKwh = (lifetimeEnergy - solarEnergyTodayStart) / 3600000;
    }

    return {
      yesterdayKwh: round1(solarEnergyYesterday),
      todayKwh: round1(todayKwh),
      panelPower: round1(totalEnergy),
    };
  }

  function collectTanks() {
    const tanks = [];
    try {
      const tankTypes = app.signalk.self && app.signalk.self.tanks;
      if (tankTypes && typeof tankTypes === 'object') {
        for (const [type, instances] of Object.entries(tankTypes)) {
          if (instances && typeof instances === 'object') {
            for (const [id, data] of Object.entries(instances)) {
              const level =
                data && data.currentLevel && data.currentLevel.value;
              const capacity =
                data && data.capacity && data.capacity.value;
              const name = (data && data.name && data.name.value) || type;
              tanks.push({
                type,
                id,
                name,
                levelRatio: level,
                levelPct: pct(level),
                capacityLiters: capacity ? Math.round(capacity * 1000) : null,
              });
            }
          }
        }
      }
    } catch (_) {}
    return tanks;
  }

  function collectDepth() {
    const depth = getSelfPath('environment.depth.belowTransducer');
    return depth != null ? round1(depth) : null;
  }

  function collectPosition() {
    const pos = getSelfPath('navigation.position');
    if (pos && pos.latitude != null && pos.longitude != null) {
      return { latitude: pos.latitude, longitude: pos.longitude };
    }
    return null;
  }

  function collectWeather() {
    const parts = [];
    const temp = getSelfPath('environment.outside.temperature');
    if (temp != null) parts.push(`${round1(temp - 273.15)}°C`);
    const humidity = getSelfPath('environment.outside.humidity');
    if (humidity != null) parts.push(`${pct(humidity)}% humidity`);
    const pressure = getSelfPath('environment.outside.pressure');
    if (pressure != null) parts.push(`${Math.round(pressure / 100)} hPa`);
    const wind = getSelfPath('environment.wind.speedApparent');
    if (wind != null) parts.push(`Wind ${round1(wind * 1.94384)} kts`);
    return parts.length ? parts.join(' | ') : null;
  }

  function collectAlarms() {
    const alarms = [];
    try {
      const notifs = app.signalk.self && app.signalk.self.notifications;
      if (notifs && typeof notifs === 'object') {
        walkNotifications(notifs, 'notifications', alarms);
      }
    } catch (_) {}
    return alarms;
  }

  function walkNotifications(obj, prefix, alarms) {
    if (obj && obj.value && obj.value.state && obj.value.state !== 'normal') {
      alarms.push({
        path: prefix,
        state: obj.value.state,
        message: obj.value.message || prefix,
      });
      return;
    }
    if (obj && typeof obj === 'object') {
      for (const [key, child] of Object.entries(obj)) {
        if (key === 'meta' || key === '$source' || key === 'timestamp') continue;
        walkNotifications(child, `${prefix}.${key}`, alarms);
      }
    }
  }

  // ── reverse geocoding ────────────────────────────────────────────────

  function reverseGeocode(lat, lon) {
    return new Promise((resolve) => {
      const reqUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;
      const opts = url.parse(reqUrl);
      opts.headers = { 'User-Agent': 'signalk-notify/1.0' };

      const req = https.get(opts, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
          } catch (_) {
            resolve(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
          }
        });
      });
      req.on('error', () => resolve(`${lat.toFixed(4)}, ${lon.toFixed(4)}`));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      });
    });
  }

  // ── digest builder ───────────────────────────────────────────────────

  async function buildDigest(options) {
    const tz = getTimezone(options);
    const battery = collectBattery();
    const solar = collectSolar();
    const tanks = collectTanks();
    const depth = collectDepth();
    const position = collectPosition();
    const weather = collectWeather();
    const alarms = collectAlarms();

    let locationName = null;
    if (position) {
      try {
        locationName = await reverseGeocode(position.latitude, position.longitude);
      } catch (_) {
        locationName = `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`;
      }
    }

    return {
      timestamp: new Date(),
      dateFormatted: formatDate(new Date(), tz),
      battery,
      solar,
      tanks,
      depth,
      position,
      locationName,
      weather,
      alarms,
    };
  }

  // ── message formatters ───────────────────────────────────────────────

  function digestToPlainLines(digest) {
    const lines = [];
    lines.push(`Vessel Status — ${digest.dateFormatted}`);
    lines.push('');

    const b = digest.battery;
    if (b.socPct != null) {
      lines.push(
        `Battery: ${b.socPct}% — ${b.stateLabel} | ${b.voltage != null ? b.voltage + 'V' : '—'} | ${b.current != null ? (b.current > 0 ? '+' : '') + b.current + 'A' : '—'}`
      );
    }

    const s = digest.solar;
    if (s.yesterdayKwh != null || s.todayKwh != null) {
      lines.push(
        `Solar: Yesterday ${s.yesterdayKwh || 0}kWh | Today ${s.todayKwh || 0}kWh`
      );
    }

    for (const t of digest.tanks) {
      const litres = t.capacityLiters && t.levelRatio != null
        ? ` (${Math.round(t.capacityLiters * t.levelRatio)}L)`
        : '';
      lines.push(
        `${t.name}: ${t.levelPct != null ? t.levelPct + '%' : '—'}${litres}`
      );
    }

    if (digest.depth != null) {
      lines.push(`Depth: ${digest.depth}m`);
    }

    if (digest.locationName) {
      lines.push(`Position: ${digest.locationName}`);
    } else if (digest.position) {
      lines.push(
        `Position: ${digest.position.latitude.toFixed(4)}, ${digest.position.longitude.toFixed(4)}`
      );
    }

    if (digest.weather) {
      lines.push(`Weather: ${digest.weather}`);
    }

    if (digest.alarms.length) {
      lines.push('');
      lines.push('Active alarms:');
      for (const a of digest.alarms) {
        lines.push(`  ⚠ [${a.state}] ${a.message}`);
      }
    }

    return lines;
  }

  function formatDiscordDigest(digest) {
    const lines = digestToPlainLines(digest);
    const b = digest.battery;

    // color: green if soc > 50, amber 20-50, red < 20
    let color = 0x2ecc71; // green
    if (b.socPct != null) {
      if (b.socPct < 20) color = 0xe74c3c;
      else if (b.socPct < 50) color = 0xf39c12;
    }

    const description = [];
    if (b.socPct != null) {
      description.push(
        `🔋 **Battery:** ${b.socPct}% — ${b.stateLabel} | ${b.voltage != null ? b.voltage + 'V' : '—'} | ${b.current != null ? (b.current > 0 ? '+' : '') + b.current + 'A' : '—'}`
      );
    }
    const s = digest.solar;
    if (s.yesterdayKwh != null || s.todayKwh != null) {
      description.push(
        `☀️ **Solar:** Yesterday ${s.yesterdayKwh || 0}kWh | Today ${s.todayKwh || 0}kWh`
      );
    }
    for (const t of digest.tanks) {
      const emoji = t.type === 'freshWater' ? '💧' : t.type === 'fuel' ? '⛽' : '🫙';
      const label = t.type === 'freshWater' ? 'Fresh water' : t.type === 'fuel' ? 'Fuel' : t.name;
      const litres = t.capacityLiters && t.levelRatio != null
        ? ` (${Math.round(t.capacityLiters * t.levelRatio)}L)`
        : '';
      description.push(
        `${emoji} **${label}:** ${t.levelPct != null ? t.levelPct + '%' : '—'}${litres}`
      );
    }
    if (digest.depth != null) {
      description.push(`🌊 **Depth:** ${digest.depth}m`);
    }
    if (digest.locationName) {
      description.push(`📍 **Position:** ${digest.locationName}`);
    } else if (digest.position) {
      description.push(
        `📍 **Position:** ${digest.position.latitude.toFixed(4)}, ${digest.position.longitude.toFixed(4)}`
      );
    }
    if (digest.weather) {
      description.push(`🌤️ **Weather:** ${digest.weather}`);
    }
    if (digest.alarms.length) {
      description.push('');
      for (const a of digest.alarms) {
        description.push(`🚨 **[${a.state}]** ${a.message}`);
      }
    }

    return {
      embeds: [
        {
          title: `🚢 **Vessel Status** — ${digest.dateFormatted}`,
          description: description.join('\n'),
          color,
          timestamp: digest.timestamp.toISOString(),
        },
      ],
    };
  }

  function formatDiscordAlert(alert) {
    let color = 0xe74c3c; // red
    if (alert.severity === 'warning') color = 0xf39c12;

    return {
      embeds: [
        {
          title: `⚠️ Alert`,
          description: alert.message,
          color,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  function formatTelegramDigest(digest) {
    const lines = [];
    lines.push(`🚢 *Vessel Status* — ${digest.dateFormatted}`);
    lines.push('');
    const b = digest.battery;
    if (b.socPct != null) {
      lines.push(
        `🔋 *Battery:* ${b.socPct}% — ${b.stateLabel} | ${b.voltage != null ? b.voltage + 'V' : '—'} | ${b.current != null ? (b.current > 0 ? '+' : '') + b.current + 'A' : '—'}`
      );
    }
    const s = digest.solar;
    if (s.yesterdayKwh != null || s.todayKwh != null) {
      lines.push(
        `☀️ *Solar:* Yesterday ${s.yesterdayKwh || 0}kWh | Today ${s.todayKwh || 0}kWh`
      );
    }
    for (const t of digest.tanks) {
      const emoji = t.type === 'freshWater' ? '💧' : t.type === 'fuel' ? '⛽' : '🫙';
      const label = t.type === 'freshWater' ? 'Fresh water' : t.type === 'fuel' ? 'Fuel' : t.name;
      const litres = t.capacityLiters && t.levelRatio != null
        ? ` (${Math.round(t.capacityLiters * t.levelRatio)}L)`
        : '';
      lines.push(
        `${emoji} *${label}:* ${t.levelPct != null ? t.levelPct + '%' : '—'}${litres}`
      );
    }
    if (digest.depth != null) lines.push(`🌊 *Depth:* ${digest.depth}m`);
    if (digest.locationName) {
      lines.push(`📍 *Position:* ${digest.locationName}`);
    } else if (digest.position) {
      lines.push(
        `📍 *Position:* ${digest.position.latitude.toFixed(4)}, ${digest.position.longitude.toFixed(4)}`
      );
    }
    if (digest.weather) lines.push(`🌤️ *Weather:* ${digest.weather}`);
    if (digest.alarms.length) {
      lines.push('');
      for (const a of digest.alarms) {
        lines.push(`🚨 *[${a.state}]* ${a.message}`);
      }
    }
    return lines.join('\n');
  }

  function formatTelegramAlert(alert) {
    return `⚠️ *Alert*\n${alert.message}`;
  }

  function formatSlackDigest(digest) {
    const b = digest.battery;
    let color = '#2ecc71';
    if (b.socPct != null) {
      if (b.socPct < 20) color = '#e74c3c';
      else if (b.socPct < 50) color = '#f39c12';
    }

    const fields = [];
    if (b.socPct != null) {
      fields.push({
        title: 'Battery',
        value: `${b.socPct}% — ${b.stateLabel} | ${b.voltage != null ? b.voltage + 'V' : '—'} | ${b.current != null ? (b.current > 0 ? '+' : '') + b.current + 'A' : '—'}`,
        short: false,
      });
    }
    const s = digest.solar;
    if (s.yesterdayKwh != null || s.todayKwh != null) {
      fields.push({
        title: 'Solar',
        value: `Yesterday ${s.yesterdayKwh || 0}kWh | Today ${s.todayKwh || 0}kWh`,
        short: true,
      });
    }
    for (const t of digest.tanks) {
      const label = t.type === 'freshWater' ? 'Fresh Water' : t.type === 'fuel' ? 'Fuel' : t.name;
      const litres = t.capacityLiters && t.levelRatio != null
        ? ` (${Math.round(t.capacityLiters * t.levelRatio)}L)`
        : '';
      fields.push({
        title: label,
        value: `${t.levelPct != null ? t.levelPct + '%' : '—'}${litres}`,
        short: true,
      });
    }
    if (digest.depth != null) {
      fields.push({ title: 'Depth', value: `${digest.depth}m`, short: true });
    }
    if (digest.locationName) {
      fields.push({ title: 'Position', value: digest.locationName, short: false });
    } else if (digest.position) {
      fields.push({
        title: 'Position',
        value: `${digest.position.latitude.toFixed(4)}, ${digest.position.longitude.toFixed(4)}`,
        short: false,
      });
    }
    if (digest.weather) {
      fields.push({ title: 'Weather', value: digest.weather, short: false });
    }
    if (digest.alarms.length) {
      const alarmText = digest.alarms
        .map((a) => `[${a.state}] ${a.message}`)
        .join('\n');
      fields.push({ title: 'Active Alarms', value: alarmText, short: false });
    }

    return {
      attachments: [
        {
          fallback: `Vessel Status — ${digest.dateFormatted}`,
          color,
          title: `🚢 Vessel Status — ${digest.dateFormatted}`,
          fields,
          ts: Math.floor(digest.timestamp.getTime() / 1000),
        },
      ],
    };
  }

  function formatSlackAlert(alert) {
    return {
      attachments: [
        {
          fallback: alert.message,
          color: alert.severity === 'warning' ? '#f39c12' : '#e74c3c',
          title: '⚠️ Alert',
          text: alert.message,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  }

  function formatGenericDigest(digest, webhook) {
    if (webhook.template) {
      return applyTemplate(webhook.template, flattenDigest(digest));
    }
    return {
      type: 'digest',
      ...flattenDigest(digest),
    };
  }

  function formatGenericAlert(alert, webhook) {
    if (webhook.template) {
      return applyTemplate(webhook.template, alert);
    }
    return {
      type: 'alert',
      message: alert.message,
      severity: alert.severity,
      path: alert.path || null,
      timestamp: new Date().toISOString(),
    };
  }

  function flattenDigest(digest) {
    const flat = {
      dateFormatted: digest.dateFormatted,
      timestamp: digest.timestamp.toISOString(),
      batterySocPct: digest.battery.socPct,
      batteryVoltage: digest.battery.voltage,
      batteryCurrent: digest.battery.current,
      batteryState: digest.battery.stateLabel,
      solarYesterdayKwh: digest.solar.yesterdayKwh,
      solarTodayKwh: digest.solar.todayKwh,
      depth: digest.depth,
      locationName: digest.locationName || '',
      latitude: digest.position ? digest.position.latitude : null,
      longitude: digest.position ? digest.position.longitude : null,
      weather: digest.weather || '',
      alarmCount: digest.alarms.length,
    };
    digest.tanks.forEach((t, i) => {
      flat[`tank_${i}_name`] = t.name;
      flat[`tank_${i}_pct`] = t.levelPct;
      flat[`tank_${i}_type`] = t.type;
    });
    return flat;
  }

  function applyTemplate(template, data) {
    let result = typeof template === 'string' ? template : JSON.stringify(template);
    for (const [key, val] of Object.entries(data)) {
      result = result.replace(
        new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
        val != null ? String(val) : ''
      );
    }
    try {
      return JSON.parse(result);
    } catch (_) {
      return result;
    }
  }

  // ── sending ──────────────────────────────────────────────────────────

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
          'User-Agent': 'signalk-notify/1.0',
        },
      };

      const req = transport.request(opts, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(new Error(`Webhook ${parsed.hostname} returned ${res.statusCode}: ${responseBody}`));
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

  function sendTelegram(webhookUrl, text) {
    // webhookUrl = https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
    const parsed = url.parse(webhookUrl, true);
    const chatId = parsed.query.chat_id;
    const apiUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

    return sendWebhook(apiUrl, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
  }

  async function dispatchDigest(digest, options) {
    const webhooks = options.webhooks || [];
    for (const wh of webhooks) {
      if (!wh.url || !wh.type) continue;
      const events = wh.events || ['all'];
      if (!events.includes('digest') && !events.includes('all')) continue;

      try {
        let payload;
        switch (wh.type) {
          case 'discord':
            payload = formatDiscordDigest(digest);
            await sendWebhook(wh.url, payload);
            break;
          case 'telegram':
            await sendTelegram(wh.url, formatTelegramDigest(digest));
            break;
          case 'slack':
            payload = formatSlackDigest(digest);
            await sendWebhook(wh.url, payload);
            break;
          case 'generic':
            payload = formatGenericDigest(digest, wh);
            await sendWebhook(wh.url, payload);
            break;
        }
        app.debug(`Digest sent to ${wh.name || wh.type}`);
      } catch (err) {
        app.error(`Failed to send digest to ${wh.name || wh.type}: ${err.message}`);
      }
    }
  }

  async function dispatchAlert(alert, options) {
    const webhooks = options.webhooks || [];
    for (const wh of webhooks) {
      if (!wh.url || !wh.type) continue;
      const events = wh.events || ['all'];
      if (!events.includes('alert') && !events.includes('all')) continue;

      try {
        let payload;
        switch (wh.type) {
          case 'discord':
            payload = formatDiscordAlert(alert);
            await sendWebhook(wh.url, payload);
            break;
          case 'telegram':
            await sendTelegram(wh.url, formatTelegramAlert(alert));
            break;
          case 'slack':
            payload = formatSlackAlert(alert);
            await sendWebhook(wh.url, payload);
            break;
          case 'generic':
            payload = formatGenericAlert(alert, wh);
            await sendWebhook(wh.url, payload);
            break;
        }
        app.debug(`Alert sent to ${wh.name || wh.type}`);
      } catch (err) {
        app.error(`Failed to send alert to ${wh.name || wh.type}: ${err.message}`);
      }
    }
  }

  // ── threshold checks ─────────────────────────────────────────────────

  function checkCooldown(key, cooldownMinutes) {
    const now = Date.now();
    const last = alertCooldowns[key];
    if (last && now - last < cooldownMinutes * 60000) return false;
    alertCooldowns[key] = now;
    return true;
  }

  function checkThresholds(options) {
    if (!options.alertsEnabled) return;
    const thresholds = options.thresholds || {};
    const batterySoCLow = thresholds.batterySoCLow != null ? thresholds.batterySoCLow : 20;
    const batterySoCHigh = thresholds.batterySoCHigh != null ? thresholds.batterySoCHigh : 95;
    const tankLow = thresholds.tankLow != null ? thresholds.tankLow : 15;

    // Battery SoC
    const soc = getSelfPath('electrical.batteries.house.capacity.stateOfCharge');
    if (soc != null) {
      const socPct = Math.round(soc * 100);
      if (socPct <= batterySoCLow && checkCooldown('battery_low', 30)) {
        dispatchAlert(
          {
            severity: 'critical',
            message: `🔋 Battery low: ${socPct}% (threshold: ${batterySoCLow}%)`,
            path: 'electrical.batteries.house.capacity.stateOfCharge',
          },
          options
        );
      }
      if (socPct >= batterySoCHigh && checkCooldown('battery_high', 30)) {
        dispatchAlert(
          {
            severity: 'warning',
            message: `🔋 Battery high: ${socPct}% (threshold: ${batterySoCHigh}%)`,
            path: 'electrical.batteries.house.capacity.stateOfCharge',
          },
          options
        );
      }
    }

    // Tank levels
    const tanks = collectTanks();
    for (const t of tanks) {
      if (t.levelPct != null && t.levelPct <= tankLow) {
        const key = `tank_${t.type}_${t.id}_low`;
        if (checkCooldown(key, 60)) {
          const label = t.type === 'freshWater' ? 'Fresh water' : t.type === 'fuel' ? 'Fuel' : t.name;
          dispatchAlert(
            {
              severity: 'warning',
              message: `💧 ${label} tank low: ${t.levelPct}% (threshold: ${tankLow}%)`,
              path: `tanks.${t.type}.${t.id}.currentLevel`,
            },
            options
          );
        }
      }
    }

    // Anchor drag
    checkAnchorDrag(options);

    // Bilge
    checkBilge(options);

    // Custom alerts
    checkCustomAlerts(options);
  }

  function checkAnchorDrag(options) {
    const anchorPosition = getSelfPath('navigation.anchor.position');
    const maxRadius = getSelfPath('navigation.anchor.maxRadius');
    const currentPosition = getSelfPath('navigation.position');

    if (!anchorPosition || !currentPosition || !maxRadius) return;

    const dist = haversineDistance(
      anchorPosition.latitude,
      anchorPosition.longitude,
      currentPosition.latitude,
      currentPosition.longitude
    );

    if (dist > maxRadius && checkCooldown('anchor_drag', 5)) {
      dispatchAlert(
        {
          severity: 'critical',
          message: `⚓ Anchor drag detected! Drifted ${Math.round(dist)}m (radius: ${Math.round(maxRadius)}m)`,
          path: 'navigation.anchor',
        },
        options
      );
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

  function checkBilge(options) {
    const bilge = getSelfPath('tanks.bilge.0.currentLevel');
    if (bilge == null) return;
    // treat anything > 50% as high bilge
    if (bilge > 0.5 && checkCooldown('bilge_high', 15)) {
      dispatchAlert(
        {
          severity: 'critical',
          message: `🚨 High bilge level: ${pct(bilge)}%`,
          path: 'tanks.bilge.0.currentLevel',
        },
        options
      );
    }
  }

  function checkCustomAlerts(options) {
    const customAlerts = options.customAlerts || [];
    for (const ca of customAlerts) {
      if (!ca.path || !ca.operator || ca.value == null) continue;
      const actual = getSelfPath(ca.path);
      if (actual == null) continue;

      let triggered = false;
      switch (ca.operator) {
        case '<':
          triggered = actual < ca.value;
          break;
        case '<=':
          triggered = actual <= ca.value;
          break;
        case '>':
          triggered = actual > ca.value;
          break;
        case '>=':
          triggered = actual >= ca.value;
          break;
        case '==':
          triggered = actual == ca.value;
          break;
        case '!=':
          triggered = actual != ca.value;
          break;
      }

      if (triggered) {
        const cooldown = ca.cooldownMinutes || 30;
        const key = `custom_${ca.path}_${ca.operator}_${ca.value}`;
        if (checkCooldown(key, cooldown)) {
          dispatchAlert(
            {
              severity: 'warning',
              message: ca.message || `Alert: ${ca.path} is ${actual} (${ca.operator} ${ca.value})`,
              path: ca.path,
            },
            options
          );
        }
      }
    }
  }

  // ── digest scheduling ────────────────────────────────────────────────

  function scheduleDigest(options) {
    if (digestTimer) {
      clearTimeout(digestTimer);
      digestTimer = null;
    }
    if (!options.digestEnabled) return;

    const tz = getTimezone(options);
    const [targetHour, targetMin] = (options.digestTime || '08:00')
      .split(':')
      .map(Number);

    function scheduleNext() {
      const now = nowInTimezone(tz);
      const target = new Date(now);
      target.setHours(targetHour, targetMin, 0, 0);

      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }

      const delay = target.getTime() - now.getTime();
      app.debug(`Next digest in ${Math.round(delay / 60000)} minutes`);

      digestTimer = setTimeout(async () => {
        try {
          const digest = await buildDigest(options);
          await dispatchDigest(digest, options);
          app.debug('Daily digest sent');
        } catch (err) {
          app.error(`Digest error: ${err.message}`);
        }
        scheduleNext();
      }, delay);
    }

    scheduleNext();
  }

  // ── alert polling ────────────────────────────────────────────────────

  let alertInterval = null;

  function startAlertPolling(options) {
    if (alertInterval) clearInterval(alertInterval);
    if (!options.alertsEnabled) return;

    // check every 30 seconds
    alertInterval = setInterval(() => {
      checkThresholds(options);
    }, 30000);

    // also run an initial check
    setTimeout(() => checkThresholds(options), 5000);
  }

  // ── plugin lifecycle ─────────────────────────────────────────────────

  plugin.start = function (options) {
    app.debug('signalk-notify starting');

    scheduleDigest(options);
    startAlertPolling(options);

    app.debug('signalk-notify started');
  };

  plugin.stop = function () {
    if (digestTimer) {
      clearTimeout(digestTimer);
      digestTimer = null;
    }
    if (alertInterval) {
      clearInterval(alertInterval);
      alertInterval = null;
    }
    alertCooldowns = {};
    app.debug('signalk-notify stopped');
  };

  // ── schema ───────────────────────────────────────────────────────────

  plugin.schema = {
    type: 'object',
    title: 'SignalK Notify',
    description:
      'Configure webhook destinations, daily digest, and alert thresholds.',
    properties: {
      webhooks: {
        type: 'array',
        title: 'Webhooks',
        items: {
          type: 'object',
          required: ['type', 'url'],
          properties: {
            name: {
              type: 'string',
              title: 'Name',
              description: 'Friendly name for this webhook',
            },
            type: {
              type: 'string',
              title: 'Type',
              enum: ['discord', 'telegram', 'slack', 'generic'],
              default: 'discord',
            },
            url: {
              type: 'string',
              title: 'Webhook URL',
              description:
                'Discord/Slack: webhook URL. Telegram: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>',
            },
            events: {
              type: 'array',
              title: 'Events',
              items: {
                type: 'string',
                enum: ['digest', 'alert', 'all'],
              },
              default: ['all'],
              uniqueItems: true,
            },
            template: {
              type: 'object',
              title: 'Custom JSON Template (generic only)',
              description:
                'JSON template with {{variable}} placeholders for generic webhooks',
            },
          },
        },
      },
      digestEnabled: {
        type: 'boolean',
        title: 'Enable Daily Digest',
        default: true,
      },
      digestTime: {
        type: 'string',
        title: 'Digest Time (HH:MM, local time)',
        default: '08:00',
        pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
      },
      alertsEnabled: {
        type: 'boolean',
        title: 'Enable Threshold Alerts',
        default: true,
      },
      thresholds: {
        type: 'object',
        title: 'Alert Thresholds',
        properties: {
          batterySoCLow: {
            type: 'number',
            title: 'Battery SoC Low (%)',
            default: 20,
            minimum: 0,
            maximum: 100,
          },
          batterySoCHigh: {
            type: 'number',
            title: 'Battery SoC High (%)',
            default: 95,
            minimum: 0,
            maximum: 100,
          },
          tankLow: {
            type: 'number',
            title: 'Tank Low (%)',
            default: 15,
            minimum: 0,
            maximum: 100,
          },
        },
      },
      customAlerts: {
        type: 'array',
        title: 'Custom Alerts',
        items: {
          type: 'object',
          required: ['path', 'operator', 'value'],
          properties: {
            path: {
              type: 'string',
              title: 'SignalK Path',
              description: 'e.g. environment.outside.temperature',
            },
            operator: {
              type: 'string',
              title: 'Operator',
              enum: ['<', '<=', '>', '>=', '==', '!='],
            },
            value: {
              type: 'number',
              title: 'Threshold Value',
            },
            message: {
              type: 'string',
              title: 'Alert Message',
              description: 'Custom message when triggered',
            },
            cooldownMinutes: {
              type: 'number',
              title: 'Cooldown (minutes)',
              default: 30,
              minimum: 1,
            },
          },
        },
      },
      timezone: {
        type: 'string',
        title: 'Timezone (IANA)',
        description: 'e.g. Europe/Stockholm, America/New_York',
        default: 'UTC',
      },
    },
  };

  return plugin;
};
