# signalk-victron-cerbo

A [SignalK](https://signalk.org/) server plugin that reads data from a **Victron Cerbo GX** (or any Venus OS GX device) via **Modbus-TCP** and publishes all values as standard SignalK paths.

## Prerequisites

1. A Victron Cerbo GX (or other Venus OS device) on the same network as your SignalK server.
2. **Enable Modbus-TCP** on the Cerbo:
   - Go to **Settings → Services → Modbus-TCP** and enable it.
3. Note the **IP address** of the Cerbo GX.

## Installation

Install via the SignalK Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-victron-cerbo
```

Then restart SignalK and enable the plugin in **Server → Plugin Config → Victron Cerbo GX (Modbus-TCP)**.

## Configuration

| Field | Default | Description |
|---|---|---|
| **host** | *(required)* | IP address of the Victron Cerbo GX |
| **port** | `502` | Modbus-TCP port |
| **pollInterval** | `5000` | Poll interval in milliseconds |
| **batteryUnit** | `100` | Modbus unit ID for system overview (`com.victronenergy.system`) |
| **solarUnit** | `288` | Modbus unit ID for the first MPPT solar charger |
| **tankUnit** | `24` | Modbus unit ID for the tank sensor |
| **tankType** | `freshWater` | Tank type: `freshWater`, `blackWater`, `wasteWater`, or `fuel` |
| **enableBattery** | `true` | Read battery/system registers |
| **enableSolar** | `true` | Read MPPT solar charger registers |
| **enableTanks** | `false` | Read tank sensor registers |
| **enableGrid** | `true` | Read grid/shore power registers |

## Finding Unit IDs

Each device connected to the Cerbo GX has a unique Modbus unit ID. To find the correct IDs:

1. On the Cerbo GX, go to **Settings → Services → Modbus-TCP → Available services**.
2. Note the unit ID for each device you want to monitor.
3. Common defaults:
   - **System (com.victronenergy.system):** 100
   - **First MPPT solar charger:** 288
   - **Tank sensors:** 20–29 (depends on connection order)

## Register / SignalK Path Mapping

### System Registers (Unit 100)

| Register | Raw Scale | SignalK Path | Units | Description |
|---|---|---|---|---|
| 820 | ÷100 | `electrical.batteries.main.capacity.stateOfCharge` | ratio (0–1) | Battery state of charge |
| 840 | ÷10 | `electrical.batteries.main.voltage` | V | Battery voltage |
| 841 | ÷10 | `electrical.batteries.main.current` | A | Battery current (positive = charging) |
| 842 | ×1 | `electrical.batteries.main.power` | W | Battery power |
| 843 | ÷10 +273.15 | `electrical.batteries.main.temperature` | K | Battery temperature |
| 850 | ×1 | `electrical.solar.total.power` | W | Total PV power |
| 851 | ×1 | `electrical.inverters.1.acout.power` | W | AC output power L1 |
| 852 | ×1 | `electrical.inverters.2.acout.power` | W | AC output power L2 |
| 853 | ×1 | `electrical.inverters.3.acout.power` | W | AC output power L3 |
| 855 | ×1 | `electrical.grid.power` | W | Grid / shore power |
| 860 | ×1 | `electrical.batteries.main.capacity.timeRemaining` | s | Battery time-to-go |

### Solar Charger Registers (Unit 288)

| Register | Raw Scale | SignalK Path | Units | Description |
|---|---|---|---|---|
| 771 | ÷100 | `electrical.solar.1.panelVoltage` | V | PV array voltage |
| 772 | ÷10 | `electrical.solar.1.panelCurrent` | A | PV array current |
| 773 | ÷100 | `electrical.solar.1.voltage` | V | Charger output voltage |
| 774 | ÷10 | `electrical.solar.1.current` | A | Charger output current |
| 775 | ×1 | `electrical.solar.1.chargePower` | W | Charger power |
| 776 | ×10 | `electrical.solar.1.yieldToday` | J | Energy harvested today |
| 777 | ×10 | `electrical.solar.1.yieldTotal` | J | Total energy harvested |

### Tank Registers (Unit 24)

| Register | Raw Scale | SignalK Path | Units | Description |
|---|---|---|---|---|
| 3000 | ÷1000 | `tanks.freshWater.0.currentLevel` | ratio (0–1) | Fluid level |
| 3001 | ÷1000 | `tanks.freshWater.0.capacity` | m³ | Tank capacity |

*Tank path prefix changes based on the configured `tankType`.*

## Debugging

Enable debug logging:

```bash
DEBUG=signalk-victron-cerbo signalk-server
```

## License

MIT
