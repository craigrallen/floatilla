'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_PATHS = [
  'navigation.position',
  'navigation.courseOverGroundTrue',
  'navigation.speedOverGround',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.wind.speedTrue',
  'environment.wind.angleTrueWater',
  'environment.depth.belowTransducer',
  'environment.depth.belowSurface',
  'environment.water.temperature',
  'environment.outside.temperature',
  'environment.outside.pressure',
  'electrical.batteries.*.capacity.stateOfCharge',
  'electrical.solar.*.power'
]

const SOG_PATH = 'navigation.speedOverGround'
const POSITION_PATH = 'navigation.position'

module.exports = function (app) {
  const plugin = {
    id: 'signalk-voyage-log',
    name: 'Voyage Log',
    description: 'Voyage Data Recorder — logs vessel data to JSONL files with voyage tracking and GPX/CSV export'
  }

  let unsubscribes = []
  let logDir
  let options
  let currentDate = null
  let writeStream = null
  let lastLogTime = {}
  let voyageState = {
    underway: false,
    currentVoyage: null,
    lastPosition: null,
    positionHistory: []
  }
  let voyages = []
  let voyagesFile
  let entryCount = 0
  let currentFileSize = 0
  let cleanupTimer = null

  plugin.schema = {
    type: 'object',
    title: 'Voyage Log Configuration',
    properties: {
      logDir: {
        type: 'string',
        title: 'Log Directory',
        description: 'Directory to store voyage log files',
        default: ''
      },
      paths: {
        type: 'array',
        title: 'SignalK Paths to Log',
        description: 'List of SignalK paths to subscribe and log. Supports * wildcards.',
        items: { type: 'string' },
        default: DEFAULT_PATHS
      },
      logInterval: {
        type: 'number',
        title: 'Log Interval (ms)',
        description: 'Minimum milliseconds between log entries per path',
        default: 10000
      },
      motionThreshold: {
        type: 'number',
        title: 'Motion Threshold (m/s)',
        description: 'Speed over ground in m/s to detect vessel is moving (0.25 ≈ 0.5 knots)',
        default: 0.25
      },
      maxFileSizeMB: {
        type: 'number',
        title: 'Max File Size (MB)',
        description: 'Rotate log file if it exceeds this size',
        default: 100
      },
      retainDays: {
        type: 'number',
        title: 'Retain Days',
        description: 'Delete log files older than this many days',
        default: 365
      }
    }
  }

  plugin.start = function (opts) {
    options = Object.assign({
      paths: DEFAULT_PATHS,
      logInterval: 10000,
      motionThreshold: 0.25,
      maxFileSizeMB: 100,
      retainDays: 365
    }, opts)

    logDir = options.logDir || path.join(app.getDataDirPath(), 'voyage-logs')

    ensureDir(logDir)

    voyagesFile = path.join(logDir, 'voyages.json')
    voyages = loadVoyages()

    // Recover in-progress voyage after restart
    const lastVoyage = voyages[voyages.length - 1]
    if (lastVoyage && !lastVoyage.end) {
      voyageState.underway = true
      voyageState.currentVoyage = lastVoyage
      app.debug('Recovered in-progress voyage %s', lastVoyage.id)
    }

    openLogStream()

    const subscriptions = buildSubscriptions(options.paths)
    if (subscriptions.length > 0) {
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          subscribe: subscriptions
        },
        unsubscribes,
        subscriptionError => {
          app.error('Subscription error: ' + subscriptionError)
        },
        delta => processDelta(delta)
      )
    }

    // Periodic cleanup of old files
    cleanupTimer = setInterval(() => cleanupOldFiles(), 24 * 60 * 60 * 1000)
    cleanupOldFiles()

    app.debug('Started. Logging %d paths to %s', options.paths.length, logDir)
  }

  plugin.stop = function () {
    unsubscribes.forEach(fn => fn())
    unsubscribes = []

    if (cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }

    // End current voyage if underway
    if (voyageState.underway && voyageState.currentVoyage) {
      endCurrentVoyage()
    }

    closeLogStream()

    lastLogTime = {}
    entryCount = 0
    currentFileSize = 0
    currentDate = null
    voyageState = {
      underway: false,
      currentVoyage: null,
      lastPosition: null,
      positionHistory: []
    }

    app.debug('Stopped')
  }

  plugin.registerWithRouter = function (router) {
    // GET /plugins/voyage-log/voyages
    router.get('/voyages', (req, res) => {
      const list = loadVoyages().map(v => ({
        id: v.id,
        start: v.start,
        end: v.end || null,
        distanceNm: v.distanceNm != null ? round(v.distanceNm, 2) : null,
        pointCount: v.pointCount || 0
      }))
      res.json(list)
    })

    // GET /plugins/voyage-log/voyages/:id/gpx
    router.get('/voyages/:id/gpx', (req, res) => {
      const voyage = findVoyage(req.params.id)
      if (!voyage) return res.status(404).json({ error: 'Voyage not found' })

      try {
        const gpx = generateGPX(voyage)
        res.set('Content-Type', 'application/gpx+xml')
        res.set('Content-Disposition', `attachment; filename="voyage-${voyage.id}.gpx"`)
        res.send(gpx)
      } catch (err) {
        app.error('GPX generation error: ' + err.message)
        res.status(500).json({ error: 'Failed to generate GPX' })
      }
    })

    // GET /plugins/voyage-log/voyages/:id/csv
    router.get('/voyages/:id/csv', (req, res) => {
      const voyage = findVoyage(req.params.id)
      if (!voyage) return res.status(404).json({ error: 'Voyage not found' })

      try {
        const csv = generateCSV(voyage)
        res.set('Content-Type', 'text/csv')
        res.set('Content-Disposition', `attachment; filename="voyage-${voyage.id}.csv"`)
        res.send(csv)
      } catch (err) {
        app.error('CSV generation error: ' + err.message)
        res.status(500).json({ error: 'Failed to generate CSV' })
      }
    })

    // GET /plugins/voyage-log/status
    router.get('/status', (req, res) => {
      const allVoyages = loadVoyages()
      const logFiles = listLogFiles()
      const totalSizeMB = logFiles.reduce((sum, f) => {
        try {
          return sum + fs.statSync(path.join(logDir, f)).size
        } catch (e) {
          return sum
        }
      }, 0) / (1024 * 1024)

      res.json({
        logging: unsubscribes.length > 0,
        logDir: logDir,
        logFiles: logFiles.length,
        totalSizeMB: round(totalSizeMB, 2),
        entriesThisSession: entryCount,
        voyageCount: allVoyages.length,
        underway: voyageState.underway,
        currentVoyageId: voyageState.currentVoyage ? voyageState.currentVoyage.id : null,
        subscribedPaths: options ? options.paths : []
      })
    })
  }

  // --- Subscription helpers ---

  function buildSubscriptions (paths) {
    return paths.map(p => ({
      path: p,
      period: options.logInterval
    }))
  }

  function processDelta (delta) {
    if (!delta.updates) return
    delta.updates.forEach(update => {
      const source = sourceLabel(update.source)
      const timestamp = update.timestamp || new Date().toISOString()
      if (!update.values) return

      update.values.forEach(pathValue => {
        const skPath = pathValue.path
        const value = pathValue.value

        // Rate-limit per path
        const now = Date.now()
        if (lastLogTime[skPath] && (now - lastLogTime[skPath]) < options.logInterval) {
          return
        }
        lastLogTime[skPath] = now

        writeLogEntry({ timestamp, path: skPath, value, source })

        // Track position for voyage detection
        if (skPath === POSITION_PATH && value && value.latitude != null && value.longitude != null) {
          updatePosition(value, timestamp)
        }

        // Track SOG for voyage detection
        if (skPath === SOG_PATH && value != null) {
          updateMotion(value, timestamp)
        }
      })
    })
  }

  function sourceLabel (src) {
    if (!src) return 'unknown'
    if (src.label) return src.label
    if (src.type && src.src) return src.type + '/' + src.src
    if (src.src) return src.src
    return 'unknown'
  }

  // --- Logging ---

  function writeLogEntry (entry) {
    const today = dateStr(new Date())
    if (today !== currentDate) {
      rotateToDate(today)
    }

    // Check file size
    if (currentFileSize > options.maxFileSizeMB * 1024 * 1024) {
      rotateOversize()
    }

    const line = JSON.stringify(entry) + '\n'
    if (writeStream) {
      writeStream.write(line)
      currentFileSize += Buffer.byteLength(line)
      entryCount++
    }
  }

  function openLogStream () {
    const today = dateStr(new Date())
    currentDate = today
    const filePath = path.join(logDir, today + '.jsonl')

    try {
      currentFileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    } catch (e) {
      currentFileSize = 0
    }

    writeStream = fs.createWriteStream(filePath, { flags: 'a' })
    writeStream.on('error', err => app.error('Log write error: ' + err.message))
  }

  function closeLogStream () {
    if (writeStream) {
      writeStream.end()
      writeStream = null
    }
  }

  function rotateToDate (today) {
    closeLogStream()
    currentDate = today
    const filePath = path.join(logDir, today + '.jsonl')

    try {
      currentFileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    } catch (e) {
      currentFileSize = 0
    }

    writeStream = fs.createWriteStream(filePath, { flags: 'a' })
    writeStream.on('error', err => app.error('Log write error: ' + err.message))
  }

  function rotateOversize () {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const overFile = path.join(logDir, currentDate + '_' + timestamp + '.jsonl')
    closeLogStream()

    // Rename current file
    const currentFile = path.join(logDir, currentDate + '.jsonl')
    try {
      if (fs.existsSync(currentFile)) {
        fs.renameSync(currentFile, overFile)
      }
    } catch (e) {
      app.error('File rotation error: ' + e.message)
    }

    // Open fresh file
    currentFileSize = 0
    writeStream = fs.createWriteStream(currentFile, { flags: 'a' })
    writeStream.on('error', err => app.error('Log write error: ' + err.message))
  }

  // --- Voyage tracking ---

  function updatePosition (pos, timestamp) {
    const prev = voyageState.lastPosition
    voyageState.lastPosition = { lat: pos.latitude, lon: pos.longitude, time: timestamp }

    if (voyageState.underway && voyageState.currentVoyage) {
      voyageState.positionHistory.push({
        lat: pos.latitude,
        lon: pos.longitude,
        time: timestamp
      })
      voyageState.currentVoyage.pointCount = (voyageState.currentVoyage.pointCount || 0) + 1

      // Accumulate distance
      if (prev) {
        const d = haversineNm(prev.lat, prev.lon, pos.latitude, pos.longitude)
        voyageState.currentVoyage.distanceNm = (voyageState.currentVoyage.distanceNm || 0) + d
      }
    }
  }

  function updateMotion (sog, timestamp) {
    if (sog > options.motionThreshold && !voyageState.underway) {
      startVoyage(timestamp)
    } else if (sog <= options.motionThreshold && voyageState.underway) {
      endCurrentVoyage()
    }
  }

  function startVoyage (timestamp) {
    const id = timestamp.replace(/[:.]/g, '-')
    const voyage = {
      id: id,
      start: timestamp,
      end: null,
      distanceNm: 0,
      pointCount: 0
    }

    voyageState.underway = true
    voyageState.currentVoyage = voyage
    voyageState.positionHistory = []

    // Seed with last known position
    if (voyageState.lastPosition) {
      voyageState.positionHistory.push({ ...voyageState.lastPosition })
    }

    voyages.push(voyage)
    saveVoyages()
    app.debug('Voyage started: %s', id)
  }

  function endCurrentVoyage () {
    if (!voyageState.currentVoyage) return
    voyageState.currentVoyage.end = new Date().toISOString()

    // Save position track for this voyage
    saveVoyageTrack(voyageState.currentVoyage.id, voyageState.positionHistory)

    saveVoyages()
    app.debug('Voyage ended: %s (%.2f NM)', voyageState.currentVoyage.id, voyageState.currentVoyage.distanceNm || 0)

    voyageState.underway = false
    voyageState.currentVoyage = null
    voyageState.positionHistory = []
  }

  function saveVoyageTrack (voyageId, positions) {
    if (!positions || positions.length === 0) return
    const trackFile = path.join(logDir, 'track-' + voyageId + '.json')
    try {
      fs.writeFileSync(trackFile, JSON.stringify(positions))
    } catch (e) {
      app.error('Failed to save voyage track: ' + e.message)
    }
  }

  function loadVoyageTrack (voyageId) {
    const trackFile = path.join(logDir, 'track-' + voyageId + '.json')
    try {
      if (fs.existsSync(trackFile)) {
        return JSON.parse(fs.readFileSync(trackFile, 'utf8'))
      }
    } catch (e) {
      app.error('Failed to load voyage track: ' + e.message)
    }
    return null
  }

  // --- Voyage index ---

  function loadVoyages () {
    try {
      if (voyagesFile && fs.existsSync(voyagesFile)) {
        return JSON.parse(fs.readFileSync(voyagesFile, 'utf8'))
      }
    } catch (e) {
      app.error('Failed to load voyages.json: ' + e.message)
    }
    return []
  }

  function saveVoyages () {
    try {
      fs.writeFileSync(voyagesFile, JSON.stringify(voyages, null, 2))
    } catch (e) {
      app.error('Failed to save voyages.json: ' + e.message)
    }
  }

  function findVoyage (id) {
    const all = loadVoyages()
    return all.find(v => v.id === id)
  }

  // --- GPX Export ---

  function generateGPX (voyage) {
    let positions = loadVoyageTrack(voyage.id)

    // If no saved track, try to reconstruct from JSONL log files
    if (!positions || positions.length === 0) {
      positions = extractPositionsFromLogs(voyage.start, voyage.end)
    }

    let gpx = '<?xml version="1.0" encoding="UTF-8"?>\n'
    gpx += '<gpx version="1.1" creator="signalk-voyage-log"\n'
    gpx += '  xmlns="http://www.topografix.com/GPX/1/1">\n'
    gpx += '  <metadata>\n'
    gpx += '    <name>Voyage ' + escapeXml(voyage.id) + '</name>\n'
    gpx += '    <time>' + escapeXml(voyage.start) + '</time>\n'
    gpx += '  </metadata>\n'
    gpx += '  <trk>\n'
    gpx += '    <name>Voyage ' + escapeXml(voyage.id) + '</name>\n'
    gpx += '    <trkseg>\n'

    if (positions) {
      positions.forEach(p => {
        gpx += '      <trkpt lat="' + p.lat + '" lon="' + p.lon + '">\n'
        if (p.time) gpx += '        <time>' + escapeXml(p.time) + '</time>\n'
        gpx += '      </trkpt>\n'
      })
    }

    gpx += '    </trkseg>\n'
    gpx += '  </trk>\n'
    gpx += '</gpx>\n'
    return gpx
  }

  // --- CSV Export ---

  function generateCSV (voyage) {
    const startTime = new Date(voyage.start)
    const endTime = voyage.end ? new Date(voyage.end) : new Date()

    // Gather data from log files covering the voyage period
    const data = extractVoyageData(startTime, endTime)

    const headers = ['timestamp', 'latitude', 'longitude', 'sog_kn', 'cog_deg', 'depth_m', 'battery_soc', 'wind_speed_kn', 'wind_angle_deg']
    let csv = headers.join(',') + '\n'

    // Build time-indexed rows from collected data
    const timeMap = {}
    data.forEach(entry => {
      const t = entry.timestamp
      if (!timeMap[t]) {
        timeMap[t] = { timestamp: t }
      }
      const row = timeMap[t]
      mapEntryToRow(row, entry)
    })

    const sortedTimes = Object.keys(timeMap).sort()
    sortedTimes.forEach(t => {
      const row = timeMap[t]
      csv += [
        row.timestamp || '',
        row.latitude != null ? row.latitude : '',
        row.longitude != null ? row.longitude : '',
        row.sog_kn != null ? round(row.sog_kn, 2) : '',
        row.cog_deg != null ? round(row.cog_deg, 1) : '',
        row.depth_m != null ? round(row.depth_m, 1) : '',
        row.battery_soc != null ? round(row.battery_soc, 3) : '',
        row.wind_speed_kn != null ? round(row.wind_speed_kn, 1) : '',
        row.wind_angle_deg != null ? round(row.wind_angle_deg, 1) : ''
      ].join(',') + '\n'
    })

    return csv
  }

  function mapEntryToRow (row, entry) {
    const p = entry.path
    const v = entry.value

    if (p === 'navigation.position' && v) {
      row.latitude = v.latitude
      row.longitude = v.longitude
    } else if (p === 'navigation.speedOverGround' && v != null) {
      row.sog_kn = v * 1.94384 // m/s to knots
    } else if (p === 'navigation.courseOverGroundTrue' && v != null) {
      row.cog_deg = v * (180 / Math.PI) // radians to degrees
    } else if ((p === 'environment.depth.belowTransducer' || p === 'environment.depth.belowSurface') && v != null) {
      row.depth_m = v
    } else if (p.match(/electrical\.batteries\..*\.capacity\.stateOfCharge/) && v != null) {
      row.battery_soc = v
    } else if (p === 'environment.wind.speedApparent' && v != null) {
      row.wind_speed_kn = v * 1.94384
    } else if (p === 'environment.wind.angleApparent' && v != null) {
      row.wind_angle_deg = v * (180 / Math.PI)
    }
  }

  // --- Log file scanning ---

  function extractPositionsFromLogs (startStr, endStr) {
    const positions = []
    const start = new Date(startStr)
    const end = endStr ? new Date(endStr) : new Date()

    const files = getLogFilesForRange(start, end)
    files.forEach(file => {
      const lines = readFileLines(path.join(logDir, file))
      lines.forEach(line => {
        try {
          const entry = JSON.parse(line)
          const t = new Date(entry.timestamp)
          if (t >= start && t <= end && entry.path === POSITION_PATH && entry.value) {
            positions.push({
              lat: entry.value.latitude,
              lon: entry.value.longitude,
              time: entry.timestamp
            })
          }
        } catch (e) { /* skip malformed lines */ }
      })
    })

    return positions
  }

  function extractVoyageData (start, end) {
    const data = []
    const files = getLogFilesForRange(start, end)

    files.forEach(file => {
      const lines = readFileLines(path.join(logDir, file))
      lines.forEach(line => {
        try {
          const entry = JSON.parse(line)
          const t = new Date(entry.timestamp)
          if (t >= start && t <= end) {
            data.push(entry)
          }
        } catch (e) { /* skip malformed lines */ }
      })
    })

    return data
  }

  function getLogFilesForRange (start, end) {
    const files = listLogFiles()
    const startDate = dateStr(start)
    const endDate = dateStr(end)
    return files.filter(f => {
      const fDate = f.substring(0, 10) // YYYY-MM-DD prefix
      return fDate >= startDate && fDate <= endDate
    })
  }

  function listLogFiles () {
    try {
      return fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort()
    } catch (e) {
      return []
    }
  }

  function readFileLines (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.length > 0)
    } catch (e) {
      return []
    }
  }

  // --- Cleanup ---

  function cleanupOldFiles () {
    if (!options || !options.retainDays) return
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - options.retainDays)
    const cutoffStr = dateStr(cutoff)

    const files = listLogFiles()
    files.forEach(f => {
      const fDate = f.substring(0, 10)
      if (fDate < cutoffStr) {
        try {
          fs.unlinkSync(path.join(logDir, f))
          app.debug('Cleaned up old log file: %s', f)
        } catch (e) {
          app.error('Failed to delete old log: ' + e.message)
        }
      }
    })
  }

  // --- Utilities ---

  function ensureDir (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  function dateStr (d) {
    return d.toISOString().substring(0, 10)
  }

  function round (n, decimals) {
    const f = Math.pow(10, decimals)
    return Math.round(n * f) / f
  }

  function escapeXml (s) {
    if (!s) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  function haversineNm (lat1, lon1, lat2, lon2) {
    const R = 3440.065 // Earth radius in nautical miles
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  function toRad (deg) {
    return deg * (Math.PI / 180)
  }

  return plugin
}
