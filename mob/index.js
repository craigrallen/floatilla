'use strict'

const https = require('https')
const http = require('http')
const url = require('url')

module.exports = function (app) {
  const plugin = {
    id: 'floatilla-mob',
    name: 'Floatilla MoB',
    description: 'Man Overboard emergency system — part of the Floatilla suite'
  }

  let state = null // null = inactive, object = active MoB
  let history = []
  let updateInterval = null
  let webhookInterval = null
  let options = {}

  // ── Helpers ──────────────────────────────────────────────────────────

  function getPosition () {
    try {
      const pos = app.getSelfPath('navigation.position')
      if (pos && pos.value && typeof pos.value.latitude === 'number' && typeof pos.value.longitude === 'number') {
        return { latitude: pos.value.latitude, longitude: pos.value.longitude }
      }
    } catch (e) {
      app.error('floatilla-mob: failed to read position: ' + e.message)
    }
    return null
  }

  function getCog () {
    try {
      const cog = app.getSelfPath('navigation.courseOverGroundTrue')
      return cog && typeof cog.value === 'number' ? cog.value : null
    } catch (e) { return null }
  }

  function getSog () {
    try {
      const sog = app.getSelfPath('navigation.speedOverGround')
      return sog && typeof sog.value === 'number' ? sog.value : null
    } catch (e) { return null }
  }

  function toDegreesMinutes (decimal, isLat) {
    const abs = Math.abs(decimal)
    const deg = Math.floor(abs)
    const min = (abs - deg) * 60
    const dir = isLat
      ? (decimal >= 0 ? 'N' : 'S')
      : (decimal >= 0 ? 'E' : 'W')
    const degStr = isLat ? String(deg).padStart(2, '0') : String(deg).padStart(3, '0')
    const minStr = min.toFixed(4).padStart(7, '0')
    return degStr + minStr + ',' + dir
  }

  function nmeaChecksum (sentence) {
    let cs = 0
    for (let i = 0; i < sentence.length; i++) {
      cs ^= sentence.charCodeAt(i)
    }
    return cs.toString(16).toUpperCase().padStart(2, '0')
  }

  function haversineDistance (lat1, lon1, lat2, lon2) {
    const R = 6371000
    const toRad = Math.PI / 180
    const dLat = (lat2 - lat1) * toRad
    const dLon = (lon2 - lon1) * toRad
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  function bearing (lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180
    const toDeg = 180 / Math.PI
    const dLon = (lon2 - lon1) * toRad
    const y = Math.sin(dLon) * Math.cos(lat2 * toRad)
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
      Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon)
    return ((Math.atan2(y, x) * toDeg) + 360) % 360
  }

  function vesselName () {
    return (options.vesselName || '').trim() || app.getSelfPath('name') || 'Unknown Vessel'
  }

  // ── SignalK Delta Publishing ─────────────────────────────────────────

  function publishDelta (updates) {
    try {
      app.handleMessage(plugin.id, {
        updates: [{
          values: updates
        }]
      })
    } catch (e) {
      app.error('floatilla-mob: delta publish error: ' + e.message)
    }
  }

  function publishMobActive (active) {
    publishDelta([{ path: 'navigation.mob.active', value: active }])
  }

  function publishMobPosition (lat, lon, ts) {
    publishDelta([
      { path: 'navigation.mob.position', value: { latitude: lat, longitude: lon, timestamp: ts } }
    ])
  }

  function publishMobNotification (mobState) {
    publishDelta([{
      path: 'notifications.mob.alert',
      value: {
        state: 'emergency',
        method: ['visual', 'sound'],
        message: 'MAN OVERBOARD at ' + mobState.position.latitude.toFixed(6) + ',' + mobState.position.longitude.toFixed(6),
        timestamp: mobState.timestamp
      }
    }])
  }

  function publishMobDistanceBearing (distance, brng) {
    publishDelta([
      { path: 'navigation.mob.distanceFromVessel', value: distance },
      { path: 'navigation.mob.bearingFromVessel', value: brng * (Math.PI / 180) } // radians per SignalK spec
    ])
  }

  function clearMobNotification () {
    publishDelta([{
      path: 'notifications.mob.alert',
      value: {
        state: 'normal',
        method: [],
        message: 'MoB cancelled',
        timestamp: new Date().toISOString()
      }
    }])
    publishMobActive(false)
  }

  // ── NMEA0183 MOB Sentence ───────────────────────────────────────────

  function emitNmeaMob (lat, lon) {
    try {
      // $GPRMB or custom MOB — we use a standard $ECMOB-style approach
      // Using $GPWPL to mark waypoint + $GPRMB for nav, but simplest standard is:
      // $--MOB — not in NMEA0183 standard, so we emit a $GPWPL (waypoint) sentence
      const latStr = toDegreesMinutes(lat, true)
      const lonStr = toDegreesMinutes(lon, false)
      const body = 'GPWPL,' + latStr + ',' + lonStr + ',MOB'
      const sentence = '$' + body + '*' + nmeaChecksum(body)
      app.emit('nmea0183out', sentence)
      app.debug('floatilla-mob: NMEA out: ' + sentence)
    } catch (e) {
      app.error('floatilla-mob: NMEA emit error: ' + e.message)
    }
  }

  // ── Webhooks ────────────────────────────────────────────────────────

  function buildMessage (mobState) {
    const lat = mobState.position.latitude.toFixed(6)
    const lon = mobState.position.longitude.toFixed(6)
    const ts = mobState.timestamp
    const name = vesselName()
    const mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lon
    return '\uD83C\uDD98 MAN OVERBOARD \u2014 ' + name + ' at ' + lat + ',' + lon + ' \u2014 ' + ts + ' \u2014 ' + mapsUrl
  }

  function postWebhook (hookUrl, body) {
    try {
      const parsed = new URL(hookUrl)
      const payload = JSON.stringify(body)
      const transport = parsed.protocol === 'https:' ? https : http
      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        app.debug('floatilla-mob: webhook ' + hookUrl + ' responded ' + res.statusCode)
      })
      req.on('error', (e) => {
        app.error('floatilla-mob: webhook error ' + hookUrl + ': ' + e.message)
      })
      req.on('timeout', () => {
        req.destroy()
        app.error('floatilla-mob: webhook timeout ' + hookUrl)
      })
      req.write(payload)
      req.end()
    } catch (e) {
      app.error('floatilla-mob: webhook post error: ' + e.message)
    }
  }

  function sendWebhooks (mobState) {
    const message = buildMessage(mobState)
    const webhooks = options.webhooks || []
    webhooks.forEach(function (hook) {
      if (!hook || !hook.url) return
      // Discord format
      if (hook.url.includes('discord.com')) {
        postWebhook(hook.url, { content: message })
      // Telegram format
      } else if (hook.url.includes('api.telegram.org')) {
        postWebhook(hook.url, { text: message, parse_mode: 'HTML' })
      } else {
        postWebhook(hook.url, { text: message, message: message })
      }
    })
    // Fleet social
    if (options.fleetSocialUrl) {
      const fleetUrl = options.fleetSocialUrl.replace(/\/$/, '') + '/mob'
      const body = {
        vessel: vesselName(),
        position: mobState.position,
        timestamp: mobState.timestamp,
        message: message
      }
      const headers = {}
      if (options.fleetSocialToken) {
        headers['Authorization'] = 'Bearer ' + options.fleetSocialToken
      }
      try {
        const parsed = new URL(fleetUrl)
        const payload = JSON.stringify(body)
        const transport = parsed.protocol === 'https:' ? https : http
        const req = transport.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: Object.assign({
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }, headers),
          timeout: 10000
        }, (res) => {
          app.debug('floatilla-mob: fleet-social responded ' + res.statusCode)
        })
        req.on('error', (e) => {
          app.error('floatilla-mob: fleet-social error: ' + e.message)
        })
        req.on('timeout', () => {
          req.destroy()
        })
        req.write(payload)
        req.end()
      } catch (e) {
        app.error('floatilla-mob: fleet-social post error: ' + e.message)
      }
    }
  }

  // ── Core Trigger / Cancel ───────────────────────────────────────────

  function triggerMob (source) {
    if (state) {
      app.debug('floatilla-mob: MoB already active, ignoring trigger')
      return state
    }

    const pos = getPosition()
    const now = new Date().toISOString()

    state = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      position: pos || { latitude: 0, longitude: 0 },
      timestamp: now,
      source: source || 'unknown',
      vesselState: {
        cog: getCog(),
        sog: getSog(),
        position: pos
      },
      cancelled: false
    }

    app.debug('floatilla-mob: MoB TRIGGERED from ' + source + ' at ' + now)

    // IMMEDIATE: SignalK deltas
    publishMobActive(true)
    if (pos) {
      publishMobPosition(pos.latitude, pos.longitude, now)
    }
    publishMobNotification(state)

    // Log event
    app.setPluginStatus('EMERGENCY: Man Overboard active since ' + now)
    app.error('floatilla-mob: *** MAN OVERBOARD *** Position: ' +
      (pos ? pos.latitude.toFixed(6) + ',' + pos.longitude.toFixed(6) : 'UNKNOWN') +
      ' Time: ' + now + ' Source: ' + source)

    // NMEA output
    if (pos) {
      emitNmeaMob(pos.latitude, pos.longitude)
    }

    // Webhooks (non-blocking)
    sendWebhooks(state)

    // History
    history.push(Object.assign({}, state))
    if (history.length > 100) history.shift()

    // Ongoing updates every 30s
    updateInterval = setInterval(function () {
      if (!state) return
      const currentPos = getPosition()
      if (currentPos && state.position) {
        const dist = haversineDistance(
          currentPos.latitude, currentPos.longitude,
          state.position.latitude, state.position.longitude
        )
        const brng = bearing(
          currentPos.latitude, currentPos.longitude,
          state.position.latitude, state.position.longitude
        )
        publishMobDistanceBearing(dist, brng)
        state.lastDistance = dist
        state.lastBearing = brng
        state.lastVesselPosition = currentPos
      }
    }, 30000)

    // Re-send webhooks every 5 minutes
    webhookInterval = setInterval(function () {
      if (!state) return
      sendWebhooks(state)
    }, 300000)

    return state
  }

  function cancelMob (reason) {
    if (!state) {
      return { success: false, error: 'No active MoB' }
    }

    const cancelled = Object.assign({}, state, {
      cancelled: true,
      cancelledAt: new Date().toISOString(),
      cancelReason: reason || 'No reason given'
    })

    // Update history
    const idx = history.findIndex(function (h) { return h.id === state.id })
    if (idx >= 0) history[idx] = cancelled

    // Clear intervals
    if (updateInterval) { clearInterval(updateInterval); updateInterval = null }
    if (webhookInterval) { clearInterval(webhookInterval); webhookInterval = null }

    // Clear SignalK state
    clearMobNotification()

    app.setPluginStatus('MoB cancelled: ' + (reason || 'no reason'))
    app.debug('floatilla-mob: MoB cancelled. Reason: ' + reason)

    state = null
    return { success: true, cancelled: cancelled }
  }

  // ── Plugin Lifecycle ────────────────────────────────────────────────

  plugin.start = function (opts) {
    options = opts || {}
    state = null
    history = []
    app.setPluginStatus('Ready')
    app.debug('floatilla-mob: started')
  }

  plugin.stop = function () {
    if (updateInterval) { clearInterval(updateInterval); updateInterval = null }
    if (webhookInterval) { clearInterval(webhookInterval); webhookInterval = null }
    if (state) {
      clearMobNotification()
      state = null
    }
    app.debug('floatilla-mob: stopped')
  }

  plugin.schema = {
    type: 'object',
    title: 'Floatilla MoB — Man Overboard',
    properties: {
      vesselName: {
        type: 'string',
        title: 'Vessel Name',
        description: 'Name of this vessel (used in alerts). Falls back to SignalK vessel name.'
      },
      webhooks: {
        type: 'array',
        title: 'Webhook URLs',
        description: 'URLs to POST MoB alerts to (Discord, Telegram, etc.)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', title: 'Label', description: 'e.g. "Discord crew channel"' },
            url: { type: 'string', title: 'URL', format: 'uri' }
          }
        }
      },
      fleetSocialUrl: {
        type: 'string',
        title: 'Fleet Social Server URL',
        description: 'Base URL of the Floatilla fleet-social server (e.g. https://fleet.example.com)'
      },
      fleetSocialToken: {
        type: 'string',
        title: 'Fleet Social Token',
        description: 'Bearer token for fleet-social authentication'
      }
    }
  }

  // ── REST API ────────────────────────────────────────────────────────

  plugin.registerWithRouter = function (router) {
    // Trigger MoB
    router.post('/trigger', function (req, res) {
      try {
        const result = triggerMob((req.body && req.body.source) || 'rest-api')
        res.json({ success: true, mob: result })
      } catch (e) {
        app.error('floatilla-mob: trigger error: ' + e.message)
        res.status(500).json({ success: false, error: e.message })
      }
    })

    // Cancel MoB
    router.post('/cancel', function (req, res) {
      try {
        if (!req.body || req.body.confirm !== true) {
          return res.status(400).json({ success: false, error: 'Must include { confirm: true, reason: "..." }' })
        }
        const result = cancelMob(req.body.reason)
        if (result.success) {
          res.json(result)
        } else {
          res.status(409).json(result)
        }
      } catch (e) {
        app.error('floatilla-mob: cancel error: ' + e.message)
        res.status(500).json({ success: false, error: e.message })
      }
    })

    // Status
    router.get('/status', function (req, res) {
      try {
        if (state) {
          const currentPos = getPosition()
          let distance = null
          let brng = null
          if (currentPos && state.position) {
            distance = haversineDistance(
              currentPos.latitude, currentPos.longitude,
              state.position.latitude, state.position.longitude
            )
            brng = bearing(
              currentPos.latitude, currentPos.longitude,
              state.position.latitude, state.position.longitude
            )
          }
          res.json({
            active: true,
            mob: state,
            distance: distance,
            bearing: brng,
            vesselPosition: currentPos,
            elapsed: Date.now() - new Date(state.timestamp).getTime()
          })
        } else {
          res.json({ active: false })
        }
      } catch (e) {
        res.status(500).json({ success: false, error: e.message })
      }
    })

    // History
    router.get('/history', function (req, res) {
      res.json({ history: history })
    })
  }

  return plugin
}
