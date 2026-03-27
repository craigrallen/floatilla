'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');

module.exports = function (app) {
  let db;
  let unsubscribes = [];
  let watchTimer = null;

  // Vessel state tracking
  const state = {
    sog: 0,
    cog: 0,
    position: null,
    depth: null,
    windSpeed: null,
    windAngle: null,
    windDirection: null,
    barometer: null,
    temperature: null,
    batterySoc: null,
    batteryVoltage: null,
    anchorSet: false,
    engineRunning: false,
    shorePower: false,
    wasMoving: false,
    lastBarometer: null
  };

  const plugin = {
    id: 'signalk-logbook',
    name: 'Logbook',
    description: 'Electronic logbook — automatic entries from vessel data, manual entries, PDF/CSV export'
  };

  plugin.schema = {
    type: 'object',
    required: ['vesselName'],
    properties: {
      vesselName: {
        type: 'string',
        title: 'Vessel Name',
        default: 'My Vessel'
      },
      watchInterval: {
        type: 'number',
        title: 'Watch interval (hours, 0 to disable)',
        default: 4
      },
      motionThreshold: {
        type: 'number',
        title: 'Motion threshold (SOG in m/s)',
        default: 0.25
      },
      logDir: {
        type: 'string',
        title: 'Storage directory (blank for default)',
        default: ''
      },
      autoEntries: {
        type: 'object',
        title: 'Automatic Entry Types',
        properties: {
          departure: { type: 'boolean', title: 'Departure detected', default: true },
          arrival: { type: 'boolean', title: 'Arrival detected', default: true },
          watch: { type: 'boolean', title: 'Watch change', default: true },
          anchor: { type: 'boolean', title: 'Anchor set/weigh', default: true },
          engine: { type: 'boolean', title: 'Engine on/off', default: true },
          shore: { type: 'boolean', title: 'Shore power', default: true },
          weather: { type: 'boolean', title: 'Weather change', default: true }
        }
      }
    }
  };

  function getDbPath(options) {
    const dir = options.logDir || path.join(app.getDataDirPath(), 'logbook');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'logbook.db');
  }

  function initDb(options) {
    const dbPath = getDbPath(options);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        lat REAL,
        lon REAL,
        depth REAL,
        sog REAL,
        cog REAL,
        wind_speed REAL,
        wind_angle REAL,
        wind_direction REAL,
        barometer REAL,
        temperature REAL,
        battery_soc REAL,
        battery_voltage REAL,
        notes TEXT,
        author TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  function currentSnapshot() {
    return {
      position: state.position ? { lat: state.position.lat, lon: state.position.lon } : null,
      depth: state.depth,
      sog: state.sog,
      cog: state.cog,
      wind: {
        speed: state.windSpeed,
        angle: state.windAngle,
        direction: state.windDirection
      },
      barometer: state.barometer,
      temperature: state.temperature,
      battery: {
        soc: state.batterySoc,
        voltage: state.batteryVoltage
      }
    };
  }

  function insertEntry(entry) {
    const id = entry.id || uuidv4();
    const ts = entry.timestamp || new Date().toISOString();
    const pos = entry.position || {};
    const wind = entry.wind || {};
    const bat = entry.battery || {};

    const stmt = db.prepare(`
      INSERT INTO entries (id, timestamp, type, category, lat, lon, depth, sog, cog,
        wind_speed, wind_angle, wind_direction, barometer, temperature,
        battery_soc, battery_voltage, notes, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, ts, entry.type || 'manual', entry.category || 'note',
      pos.lat ?? null, pos.lon ?? null,
      entry.depth ?? null, entry.sog ?? null, entry.cog ?? null,
      wind.speed ?? null, wind.angle ?? null, wind.direction ?? null,
      entry.barometer ?? null, entry.temperature ?? null,
      bat.soc ?? null, bat.voltage ?? null,
      entry.notes ?? null, entry.author ?? null
    );

    return id;
  }

  function createAutoEntry(category, notes) {
    const snap = currentSnapshot();
    const entry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'auto',
      category,
      position: snap.position,
      depth: snap.depth,
      sog: snap.sog,
      cog: snap.cog,
      wind: snap.wind,
      barometer: snap.barometer,
      temperature: snap.temperature,
      battery: snap.battery,
      notes: notes || null
    };
    insertEntry(entry);
    app.debug(`Logbook auto-entry: ${category} — ${notes || ''}`);
  }

  function rowToEntry(row) {
    return {
      id: row.id,
      timestamp: row.timestamp,
      type: row.type,
      category: row.category,
      position: (row.lat != null && row.lon != null) ? { lat: row.lat, lon: row.lon } : null,
      depth: row.depth,
      sog: row.sog,
      cog: row.cog,
      wind: { speed: row.wind_speed, angle: row.wind_angle, direction: row.wind_direction },
      barometer: row.barometer,
      temperature: row.temperature,
      battery: { soc: row.battery_soc, voltage: row.battery_voltage },
      notes: row.notes,
      author: row.author
    };
  }

  function queryEntries(from, to, limit, offset) {
    let sql = 'SELECT * FROM entries WHERE 1=1';
    const params = [];
    if (from) { sql += ' AND timestamp >= ?'; params.push(from); }
    if (to) { sql += ' AND timestamp <= ?'; params.push(to); }
    sql += ' ORDER BY timestamp DESC';
    if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit, 10)); }
    if (offset) { sql += ' OFFSET ?'; params.push(parseInt(offset, 10)); }
    return db.prepare(sql).all(...params).map(rowToEntry);
  }

  // ---- CSV export ----
  function entriesToCsv(entries) {
    const headers = [
      'timestamp', 'type', 'category', 'lat', 'lon', 'depth', 'sog', 'cog',
      'wind_speed', 'wind_angle', 'wind_direction', 'barometer', 'temperature',
      'battery_soc', 'battery_voltage', 'notes', 'author'
    ];
    const lines = [headers.join(',')];
    for (const e of entries) {
      const row = [
        e.timestamp, e.type, e.category,
        e.position?.lat ?? '', e.position?.lon ?? '',
        e.depth ?? '', e.sog ?? '', e.cog ?? '',
        e.wind?.speed ?? '', e.wind?.angle ?? '', e.wind?.direction ?? '',
        e.barometer ?? '', e.temperature ?? '',
        e.battery?.soc ?? '', e.battery?.voltage ?? '',
        csvEscape(e.notes ?? ''), csvEscape(e.author ?? '')
      ];
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

  function csvEscape(val) {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ---- PDF export ----
  function entriesToPdf(entries, vesselName, res) {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="logbook.pdf"');
    doc.pipe(res);

    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Compute summary
    const dateRange = sorted.length
      ? `${sorted[0].timestamp.slice(0, 10)} — ${sorted[sorted.length - 1].timestamp.slice(0, 10)}`
      : 'No entries';

    // Header
    doc.fontSize(18).text(vesselName + ' — Logbook', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).text(dateRange, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`${sorted.length} entries`, { align: 'center' });
    doc.moveDown(1);

    // Table
    const cols = [
      { header: 'Time', width: 110, get: e => fmtTime(e.timestamp) },
      { header: 'Cat', width: 60, get: e => e.category },
      { header: 'Position', width: 110, get: e => fmtPos(e.position) },
      { header: 'SOG', width: 40, get: e => fmtNum(e.sog, 1) },
      { header: 'COG', width: 40, get: e => fmtNum(e.cog, 0) },
      { header: 'Depth', width: 45, get: e => fmtNum(e.depth, 1) },
      { header: 'Wind', width: 65, get: e => fmtWind(e.wind) },
      { header: 'Baro', width: 48, get: e => fmtNum(e.barometer, 0) },
      { header: 'Notes', width: 200, get: e => e.notes || '' }
    ];

    const tableLeft = 40;
    let y = doc.y;
    let pageNum = 1;

    function drawHeader() {
      doc.fontSize(7).font('Helvetica-Bold');
      let x = tableLeft;
      for (const col of cols) {
        doc.text(col.header, x, y, { width: col.width, align: 'left' });
        x += col.width;
      }
      doc.font('Helvetica');
      y += 14;
      doc.moveTo(tableLeft, y).lineTo(tableLeft + cols.reduce((s, c) => s + c.width, 0), y).stroke();
      y += 4;
    }

    function drawFooter() {
      doc.fontSize(7).text(`Page ${pageNum}`, 40, doc.page.height - 30, { align: 'center', width: doc.page.width - 80 });
    }

    drawHeader();

    for (const entry of sorted) {
      if (y > doc.page.height - 60) {
        drawFooter();
        doc.addPage();
        pageNum++;
        y = 40;
        drawHeader();
      }
      let x = tableLeft;
      doc.fontSize(6.5);
      for (const col of cols) {
        const text = col.get(entry);
        doc.text(text, x, y, { width: col.width, align: 'left', lineBreak: false });
        x += col.width;
      }
      y += 12;
    }

    drawFooter();
    doc.end();
  }

  function fmtTime(ts) {
    if (!ts) return '';
    return ts.replace('T', ' ').slice(0, 19);
  }

  function fmtPos(pos) {
    if (!pos || pos.lat == null) return '';
    return `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;
  }

  function fmtNum(val, decimals) {
    if (val == null) return '';
    return Number(val).toFixed(decimals);
  }

  function fmtWind(wind) {
    if (!wind || wind.speed == null) return '';
    return `${Number(wind.speed).toFixed(1)}m/s ${fmtNum(wind.angle, 0)}°`;
  }

  // ---- SignalK subscriptions ----
  function subscribePaths(options) {
    const autoOn = (cat) => options.autoEntries?.[cat] !== false;

    const paths = [
      { path: 'navigation.speedOverGround', handler: (v) => { state.sog = v ?? 0; } },
      { path: 'navigation.courseOverGroundTrue', handler: (v) => { state.cog = v ?? 0; } },
      { path: 'navigation.position', handler: (v) => {
        if (v && typeof v === 'object') state.position = v;
      }},
      { path: 'environment.depth.belowTransducer', handler: (v) => { state.depth = v; } },
      { path: 'environment.wind.speedApparent', handler: (v) => { state.windSpeed = v; } },
      { path: 'environment.wind.angleApparent', handler: (v) => { state.windAngle = v; } },
      { path: 'environment.wind.directionTrue', handler: (v) => { state.windDirection = v; } },
      { path: 'environment.outside.pressure', handler: (v) => {
        if (v != null && autoOn('weather')) {
          const prev = state.lastBarometer;
          state.barometer = v;
          if (prev != null && Math.abs(v - prev) > 300) {
            createAutoEntry('weather', `Barometer change: ${prev.toFixed(0)} → ${v.toFixed(0)} Pa`);
          }
          state.lastBarometer = v;
        } else {
          state.barometer = v;
        }
      }},
      { path: 'environment.outside.temperature', handler: (v) => { state.temperature = v; } },
      { path: 'electrical.batteries.house.capacity.stateOfCharge', handler: (v) => { state.batterySoc = v; } },
      { path: 'electrical.batteries.house.voltage', handler: (v) => { state.batteryVoltage = v; } }
    ];

    // Motion detection (departure / arrival)
    if (autoOn('departure') || autoOn('arrival')) {
      const threshold = options.motionThreshold ?? 0.25;
      const origSogHandler = paths.find(p => p.path === 'navigation.speedOverGround').handler;
      paths.find(p => p.path === 'navigation.speedOverGround').handler = (v) => {
        const prev = state.sog;
        origSogHandler(v);
        const nowMoving = (state.sog ?? 0) >= threshold;
        const wasMoving = (prev ?? 0) >= threshold;
        if (nowMoving && !wasMoving && autoOn('departure')) {
          createAutoEntry('departure', `Underway — SOG ${(state.sog ?? 0).toFixed(2)} m/s`);
        }
        if (!nowMoving && wasMoving && autoOn('arrival')) {
          createAutoEntry('arrival', `Stopped — SOG ${(state.sog ?? 0).toFixed(2)} m/s`);
        }
        state.wasMoving = nowMoving;
      };
    }

    // Anchor
    if (autoOn('anchor')) {
      paths.push({
        path: 'navigation.anchor.position',
        handler: (v) => {
          const wasSet = state.anchorSet;
          const nowSet = v != null && typeof v === 'object' && v.latitude != null;
          if (nowSet && !wasSet) {
            createAutoEntry('anchor', 'Anchor set');
          }
          if (!nowSet && wasSet) {
            createAutoEntry('anchor', 'Anchor weighed');
          }
          state.anchorSet = nowSet;
        }
      });
    }

    // Engine
    if (autoOn('engine')) {
      paths.push({
        path: 'propulsion.main.state',
        handler: (v) => {
          const wasRunning = state.engineRunning;
          const nowRunning = v === 'started' || v === 'running';
          if (nowRunning && !wasRunning) {
            createAutoEntry('engine', 'Engine started');
          }
          if (!nowRunning && wasRunning) {
            createAutoEntry('engine', 'Engine stopped');
          }
          state.engineRunning = nowRunning;
        }
      });
    }

    // Shore power
    if (autoOn('shore')) {
      paths.push({
        path: 'electrical.ac.shore.state',
        handler: (v) => {
          const was = state.shorePower;
          const now = v === 'connected' || v === true || v === 1;
          if (now && !was) {
            createAutoEntry('shore', 'Shore power connected');
          }
          if (!now && was) {
            createAutoEntry('shore', 'Shore power disconnected');
          }
          state.shorePower = now;
        }
      });
    }

    // Subscribe to all paths via delta handler
    const localSubscription = {
      context: 'vessels.self',
      subscribe: paths.map(p => ({ path: p.path, period: 5000 }))
    };

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      (subscriptionError) => {
        if (subscriptionError) {
          app.error('Logbook subscription error: ' + subscriptionError);
        }
      },
      (delta) => {
        if (delta.updates) {
          for (const update of delta.updates) {
            if (update.values) {
              for (const val of update.values) {
                const handler = paths.find(p => p.path === val.path);
                if (handler) {
                  handler.handler(val.value);
                }
              }
            }
          }
        }
      }
    );

    // Watch timer
    const watchHours = options.watchInterval ?? 4;
    if (watchHours > 0 && autoOn('watch')) {
      watchTimer = setInterval(() => {
        createAutoEntry('watch', 'Watch log');
      }, watchHours * 3600 * 1000);
    }
  }

  // ---- REST API ----
  function registerRoutes(router) {
    // List entries
    router.get('/entries', (req, res) => {
      try {
        const { from, to, limit, offset } = req.query;
        const entries = queryEntries(from, to, limit, offset);
        res.json(entries);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Create manual entry
    router.post('/entries', (req, res) => {
      try {
        const body = req.body || {};
        const snap = currentSnapshot();
        const entry = {
          type: 'manual',
          category: body.category || 'note',
          timestamp: body.timestamp || new Date().toISOString(),
          position: body.position || snap.position,
          depth: body.depth ?? snap.depth,
          sog: body.sog ?? snap.sog,
          cog: body.cog ?? snap.cog,
          wind: body.wind || snap.wind,
          barometer: body.barometer ?? snap.barometer,
          temperature: body.temperature ?? snap.temperature,
          battery: body.battery || snap.battery,
          notes: body.notes || '',
          author: body.author || ''
        };
        const id = insertEntry(entry);
        res.json({ id, ...entry });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete entry
    router.delete('/entries/:id', (req, res) => {
      try {
        const result = db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
        if (result.changes === 0) {
          return res.status(404).json({ error: 'Entry not found' });
        }
        res.json({ deleted: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // CSV export
    router.get('/export/csv', (req, res) => {
      try {
        const { from, to } = req.query;
        const entries = queryEntries(from, to);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="logbook.csv"');
        res.send(entriesToCsv(entries.reverse()));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // PDF export
    router.get('/export/pdf', (req, res) => {
      try {
        const { from, to } = req.query;
        const entries = queryEntries(from, to);
        const vesselName = plugin._options?.vesselName || 'Vessel';
        entriesToPdf(entries, vesselName, res);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    return router;
  }

  plugin.start = function (options) {
    plugin._options = options;
    app.debug('Starting logbook plugin');

    initDb(options);
    subscribePaths(options);

    app.debug('Logbook plugin started');
  };

  plugin.stop = function () {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (db) {
      db.close();
      db = null;
    }
    app.debug('Logbook plugin stopped');
  };

  plugin.registerWithRouter = function (router) {
    registerRoutes(router);
  };

  plugin.getOpenApi = function () {
    return {
      openApi: '3.0.0',
      info: {
        title: 'SignalK Logbook',
        version: '1.0.0'
      },
      paths: {
        '/entries': {
          get: { summary: 'List logbook entries' },
          post: { summary: 'Create manual logbook entry' }
        },
        '/entries/{id}': {
          delete: { summary: 'Delete a logbook entry' }
        },
        '/export/csv': {
          get: { summary: 'Export logbook as CSV' }
        },
        '/export/pdf': {
          get: { summary: 'Export logbook as PDF' }
        }
      }
    };
  };

  return plugin;
};
