'use strict'

const ModbusRTU = require('modbus-serial')
const debug = require('debug')('signalk-victron-cerbo')

const PLUGIN_ID = 'signalk-victron-cerbo'
const PLUGIN_NAME = 'Victron Cerbo GX (Modbus-TCP)'

// Register definitions: [address, signalkPathSuffix, scale, offset, signed]
// scale: multiply raw value by this factor
// offset: add after scaling (used for temperature C→K conversion)
// signed: treat raw uint16 as int16

const SYSTEM_REGISTERS = [
  { address: 820, path: 'electrical.batteries.main.capacity.stateOfCharge', scale: 0.01, offset: 0, signed: false, units: 'ratio' },
  { address: 840, path: 'electrical.batteries.main.voltage', scale: 0.1, offset: 0, signed: false, units: 'V' },
  { address: 841, path: 'electrical.batteries.main.current', scale: 0.1, offset: 0, signed: true, units: 'A' },
  { address: 842, path: 'electrical.batteries.main.power', scale: 1, offset: 0, signed: true, units: 'W' },
  { address: 843, path: 'electrical.batteries.main.temperature', scale: 0.1, offset: 273.15, signed: true, units: 'K' },
  { address: 850, path: 'electrical.solar.total.power', scale: 1, offset: 0, signed: false, units: 'W' },
  { address: 851, path: 'electrical.inverters.1.acout.power', scale: 1, offset: 0, signed: true, units: 'W' },
  { address: 852, path: 'electrical.inverters.2.acout.power', scale: 1, offset: 0, signed: true, units: 'W' },
  { address: 853, path: 'electrical.inverters.3.acout.power', scale: 1, offset: 0, signed: true, units: 'W' },
  { address: 855, path: 'electrical.grid.power', scale: 1, offset: 0, signed: true, units: 'W' },
  { address: 860, path: 'electrical.batteries.main.capacity.timeRemaining', scale: 1, offset: 0, signed: false, units: 's' }
]

const SOLAR_REGISTERS = [
  { address: 771, path: 'electrical.solar.1.panelVoltage', scale: 0.01, offset: 0, signed: false, units: 'V' },
  { address: 772, path: 'electrical.solar.1.panelCurrent', scale: 0.1, offset: 0, signed: false, units: 'A' },
  { address: 773, path: 'electrical.solar.1.voltage', scale: 0.01, offset: 0, signed: false, units: 'V' },
  { address: 774, path: 'electrical.solar.1.current', scale: 0.1, offset: 0, signed: false, units: 'A' },
  { address: 775, path: 'electrical.solar.1.chargePower', scale: 1, offset: 0, signed: false, units: 'W' },
  { address: 776, path: 'electrical.solar.1.yieldToday', scale: 10, offset: 0, signed: false, units: 'J' },
  { address: 777, path: 'electrical.solar.1.yieldTotal', scale: 10, offset: 0, signed: false, units: 'J' }
]

const TANK_REGISTERS = [
  { address: 3000, pathTemplate: 'tanks.{{tankType}}.0.currentLevel', scale: 0.001, offset: 0, signed: false, units: 'ratio' },
  { address: 3001, pathTemplate: 'tanks.{{tankType}}.0.capacity', scale: 0.001, offset: 0, signed: false, units: 'm3' }
]

// Battery group: registers whose paths start with electrical.batteries
const BATTERY_PATHS = new Set([
  'electrical.batteries.main.capacity.stateOfCharge',
  'electrical.batteries.main.voltage',
  'electrical.batteries.main.current',
  'electrical.batteries.main.power',
  'electrical.batteries.main.temperature',
  'electrical.batteries.main.capacity.timeRemaining'
])

// Grid group
const GRID_PATHS = new Set([
  'electrical.grid.power'
])

// Inverter / solar from system unit (not the solar charger unit)
const SOLAR_SYSTEM_PATHS = new Set([
  'electrical.solar.total.power',
  'electrical.inverters.1.acout.power',
  'electrical.inverters.2.acout.power',
  'electrical.inverters.3.acout.power'
])

module.exports = function (app) {
  let client = null
  let pollTimer = null
  let reconnectTimer = null
  let connected = false
  let stopping = false

  const plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'Read Victron Cerbo GX data via Modbus-TCP and publish as SignalK paths',

    schema () {
      return {
        type: 'object',
        required: ['host'],
        properties: {
          host: {
            type: 'string',
            title: 'Cerbo GX IP Address',
            description: 'IP address of the Victron Cerbo GX device'
          },
          port: {
            type: 'number',
            title: 'Modbus-TCP Port',
            default: 502,
            description: 'Modbus-TCP port (default 502)'
          },
          pollInterval: {
            type: 'number',
            title: 'Poll Interval (ms)',
            default: 5000,
            description: 'How often to read registers, in milliseconds'
          },
          batteryUnit: {
            type: 'number',
            title: 'System / Battery Unit ID',
            default: 100,
            description: 'Modbus unit ID for system overview (com.victronenergy.system)'
          },
          solarUnit: {
            type: 'number',
            title: 'Solar Charger Unit ID',
            default: 288,
            description: 'Modbus unit ID for the first MPPT solar charger'
          },
          tankUnit: {
            type: 'number',
            title: 'Tank Sensor Unit ID',
            default: 24,
            description: 'Modbus unit ID for the tank sensor'
          },
          tankType: {
            type: 'string',
            title: 'Tank Type',
            default: 'freshWater',
            enum: ['freshWater', 'blackWater', 'wasteWater', 'fuel'],
            description: 'Type of tank connected'
          },
          enableBattery: {
            type: 'boolean',
            title: 'Enable Battery Registers',
            default: true,
            description: 'Read battery/system registers'
          },
          enableSolar: {
            type: 'boolean',
            title: 'Enable Solar Charger Registers',
            default: true,
            description: 'Read MPPT solar charger registers'
          },
          enableTanks: {
            type: 'boolean',
            title: 'Enable Tank Registers',
            default: false,
            description: 'Read tank sensor registers'
          },
          enableGrid: {
            type: 'boolean',
            title: 'Enable Grid Registers',
            default: true,
            description: 'Read grid/shore power registers'
          }
        }
      }
    },

    start (options) {
      stopping = false
      const host = options.host
      const port = options.port || 502
      const pollInterval = options.pollInterval || 5000

      if (!host) {
        app.setPluginError('No host IP configured')
        return
      }

      debug('Starting plugin with host=%s port=%d interval=%dms', host, port, pollInterval)
      app.setPluginStatus('Connecting...')

      connect(host, port, pollInterval, options)
    },

    stop () {
      stopping = true
      debug('Stopping plugin')

      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (client) {
        client.close(() => {
          debug('Modbus connection closed')
        })
        client = null
      }
      connected = false
    }
  }

  function connect (host, port, pollInterval, options) {
    if (stopping) return

    client = new ModbusRTU()

    client.connectTCP(host, { port })
      .then(() => {
        connected = true
        client.setTimeout(3000)
        debug('Connected to %s:%d', host, port)
        app.setPluginStatus('Connected to ' + host)

        // Start polling
        poll(options)
        pollTimer = setInterval(() => poll(options), pollInterval)
      })
      .catch((err) => {
        connected = false
        debug('Connection failed: %s', err.message)
        app.setPluginError('Connection failed: ' + err.message)
        scheduleReconnect(host, port, pollInterval, options)
      })
  }

  function scheduleReconnect (host, port, pollInterval, options) {
    if (stopping) return

    debug('Scheduling reconnect in 10s')
    app.setPluginStatus('Reconnecting in 10s...')

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!stopping) {
        connect(host, port, pollInterval, options)
      }
    }, 10000)
  }

  function handleConnectionError (err, host, port, pollInterval, options) {
    debug('Connection error: %s', err.message)
    connected = false

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }

    if (client) {
      try { client.close(() => {}) } catch (e) { /* ignore */ }
      client = null
    }

    app.setPluginError('Connection lost: ' + err.message)
    scheduleReconnect(host, port, pollInterval, options)
  }

  async function poll (options) {
    if (!connected || !client || stopping) return

    const host = options.host
    const port = options.port || 502
    const pollInterval = options.pollInterval || 5000
    const tankType = options.tankType || 'freshWater'
    const values = []

    try {
      // Read system registers (battery, solar total, inverters, grid)
      if (options.enableBattery !== false || options.enableGrid !== false) {
        const unitId = options.batteryUnit || 100
        client.setID(unitId)

        for (const reg of SYSTEM_REGISTERS) {
          // Filter by enabled group
          if (BATTERY_PATHS.has(reg.path) && options.enableBattery === false) continue
          if (GRID_PATHS.has(reg.path) && options.enableGrid === false) continue
          if (SOLAR_SYSTEM_PATHS.has(reg.path) && options.enableSolar === false) continue

          try {
            const result = await client.readHoldingRegisters(reg.address, 1)
            const raw = result.data[0]
            const value = convertValue(raw, reg)
            if (value !== null) {
              values.push({ path: reg.path, value })
              debug('%s [%d] = %d → %s = %s', 'system', reg.address, raw, reg.path, value)
            }
          } catch (err) {
            debug('Error reading system register %d (%s): %s', reg.address, reg.path, err.message)
          }
        }
      }

      // Read solar charger registers
      if (options.enableSolar !== false) {
        const unitId = options.solarUnit || 288
        client.setID(unitId)

        for (const reg of SOLAR_REGISTERS) {
          try {
            const result = await client.readHoldingRegisters(reg.address, 1)
            const raw = result.data[0]
            const value = convertValue(raw, reg)
            if (value !== null) {
              values.push({ path: reg.path, value })
              debug('%s [%d] = %d → %s = %s', 'solar', reg.address, raw, reg.path, value)
            }
          } catch (err) {
            debug('Error reading solar register %d (%s): %s', reg.address, reg.path, err.message)
          }
        }
      }

      // Read tank registers
      if (options.enableTanks === true) {
        const unitId = options.tankUnit || 24
        client.setID(unitId)

        for (const reg of TANK_REGISTERS) {
          try {
            const result = await client.readHoldingRegisters(reg.address, 1)
            const raw = result.data[0]
            const value = convertValue(raw, reg)
            if (value !== null) {
              const path = reg.pathTemplate.replace('{{tankType}}', tankType)
              values.push({ path, value })
              debug('%s [%d] = %d → %s = %s', 'tank', reg.address, raw, path, value)
            }
          } catch (err) {
            debug('Error reading tank register %d: %s', reg.address, err.message)
          }
        }
      }

      // Publish all values
      if (values.length > 0) {
        publishDelta(values)
      }
    } catch (err) {
      handleConnectionError(err, host, port, pollInterval, options)
    }
  }

  function convertValue (raw, reg) {
    // 0xFFFF (65535) is commonly used by Victron as "not available"
    if (raw === 0xFFFF) return null

    let value = raw

    // Treat as signed int16 if needed
    if (reg.signed && value >= 0x8000) {
      value = value - 0x10000
    }

    // Apply scale and offset
    value = value * reg.scale + reg.offset

    // Round to avoid floating-point noise
    value = Math.round(value * 1000) / 1000

    return value
  }

  function publishDelta (values) {
    const updates = values.map((v) => ({
      path: v.path,
      value: v.value
    }))

    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: {
            label: PLUGIN_NAME,
            type: 'Modbus-TCP'
          },
          timestamp: new Date().toISOString(),
          values: updates
        }
      ]
    }

    debug('Publishing %d values', updates.length)
    app.handleMessage(PLUGIN_ID, delta)
  }

  return plugin
}
