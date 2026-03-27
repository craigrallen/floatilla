# signalk-energy-manager

Intelligent energy management plugin for [SignalK](https://signalk.org/) — monitors batteries, solar, shore power, and performs smart charging actions. Works with **any** brand or NMEA2000 source (Victron, Mastervolt, etc.).

## Features

### Monitoring
- **Battery SoC tracking** — rolling 24h, 7d, 30d history persisted to disk
- **Average daily consumption** in kWh
- **Charging source detection** — automatically identifies active source: solar, shore, alternator, or none
- **Solar efficiency** — compares actual output to theoretical maximum using `suncalc` + GPS position
- **Time estimates** — estimated hours to empty / full at current rates

### Derived SignalK Paths

| Path | Unit | Description |
|------|------|-------------|
| `electrical.batteries.main.capacity.consumptionRate` | W | Rolling 15-minute average discharge power |
| `electrical.batteries.main.capacity.estimatedTimeToEmpty` | hours | At current discharge rate |
| `electrical.batteries.main.capacity.estimatedTimeToFull` | hours | At current charge rate |
| `electrical.solar.efficiency` | 0–1 | Actual solar output ÷ theoretical max |
| `electrical.energyToday.consumed` | Wh | Total energy discharged today |
| `electrical.energyToday.solar` | Wh | Total solar energy harvested today |
| `electrical.charging.activeSources` | array | Active charging sources (`solar`, `shore`, `alternator`, `none`) |

### Smart Shore Power Control

The plugin adjusts shore power current limits via SignalK PUT requests:

- **SoC > high threshold** (default 90%) + shore connected → reduce shore current to minimum (default 6A)
- **SoC < low threshold** (default 30%) + shore connected → boost shore current to maximum (default 32A)
- Between thresholds → no action (existing limit maintained)
- Debounced to prevent oscillation (max one adjustment per 60 seconds)

This prevents unnecessary battery cycling when fully charged and ensures rapid charging when batteries are low.

### Alerts (notifications.*)

| Notification Path | Trigger | Severity |
|---|---|---|
| `notifications.energy.batteryCritical` | SoC below critical threshold (default 15%) | emergency |
| `notifications.energy.highConsumption` | Discharge rate > 20% of battery capacity per hour | warn |
| `notifications.energy.solarUnderperforming` | Actual output < 50% of theoretical max | warn |
| `notifications.energy.batteryDegradation` | Average SoC declining week-over-week despite similar consumption | warn |

Alerts auto-clear when conditions return to normal (with hysteresis to prevent flapping).

## Solar Theoretical Calculation

Uses the [suncalc](https://github.com/mourner/suncalc) library with the vessel's GPS position to compute a clear-sky solar power estimate:

1. Get sun altitude for current time and position
2. Calculate air mass using Kasten & Young formula
3. Apply atmospheric transmittance (0.7 clear-sky factor)
4. Multiply by installed panel Wp rating

Efficiency = actual output ÷ theoretical. Values below 50% trigger an alert (cloud cover, shading, dirty panels, or equipment issues).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `batteryPath` | `electrical.batteries.house` | SignalK base path for battery bank |
| `solarPaths` | `["electrical.solar.1.panelPower"]` | Array of solar charger power paths |
| `shorePowerPath` | `electrical.ac.shore.power` | Shore/AC input power path (read) |
| `shorePowerLimitPath` | *(empty)* | PUT path for shore current limit. Leave empty to disable control. |
| `alternatorPath` | *(empty)* | Alternator power path (optional) |
| `shoreCurrentMin` | 6 | Minimum shore amps when SoC is high |
| `shoreCurrentMax` | 32 | Maximum shore amps for boost charging |
| `socHighThreshold` | 90 | SoC % above which to reduce shore power |
| `socLowThreshold` | 30 | SoC % below which to boost shore power |
| `socCritical` | 15 | SoC % to trigger critical battery alert |
| `solarPanelWp` | 400 | Total installed solar capacity (watts-peak) |
| `batteryCapacityWh` | 5000 | Total battery capacity in Wh |
| `historyDir` | `~/.signalk/energy-history/` | Directory for persisted daily history |

## Path Configuration Examples

### Victron (via Venus OS / dbus-signalk)
```
batteryPath: electrical.batteries.house
solarPaths: ["electrical.solar.1.panelPower"]
shorePowerPath: electrical.ac.shore.power
shorePowerLimitPath: electrical.ac.shore.limit
```

### Mastervolt (via CZone / NMEA2000)
```
batteryPath: electrical.batteries.0
solarPaths: ["electrical.solar.0.panelPower"]
shorePowerPath: electrical.ac.0.power
```

### Generic NMEA2000
Configure paths to match whatever your gateway publishes. Use the SignalK data browser to find the correct paths for your installation.

## Installation

Install via the SignalK Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-energy-manager
```

Then enable and configure via **Server → Plugin Config → Energy Manager** in the SignalK admin UI.

## License

MIT
