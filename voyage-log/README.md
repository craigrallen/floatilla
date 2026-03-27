# signalk-voyage-log

A SignalK server plugin that acts as a Voyage Data Recorder (VDR). Automatically logs vessel data to structured JSONL files, tracks voyages based on vessel motion, and provides GPX and CSV export via REST API.

## Features

- Logs configurable SignalK paths to newline-delimited JSON (JSONL) files
- Daily file rotation with configurable max file size
- Automatic voyage detection based on speed over ground
- Voyage index with start/end times and distance covered
- GPX track export for any recorded voyage
- CSV data export with position, SOG, COG, depth, battery, and wind data
- REST API for querying voyages and downloading exports
- Automatic cleanup of old log files
- Works with GPS-only setups, full NMEA2000, or Victron electrical data

## Installation

Install via the SignalK Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-voyage-log
```

Then restart SignalK and enable the plugin in **Server > Plugin Config**.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `logDir` | `~/.signalk/voyage-logs/` | Directory for log files |
| `paths` | See below | SignalK paths to subscribe and log |
| `logInterval` | `10000` | Minimum ms between log entries per path |
| `motionThreshold` | `0.25` | SOG in m/s to detect motion (~0.5 knots) |
| `maxFileSizeMB` | `100` | Rotate file when exceeding this size |
| `retainDays` | `365` | Delete logs older than this many days |

### Default Paths

```
navigation.position
navigation.courseOverGroundTrue
navigation.speedOverGround
navigation.headingTrue
navigation.headingMagnetic
environment.wind.speedApparent
environment.wind.angleApparent
environment.wind.speedTrue
environment.wind.angleTrueWater
environment.depth.belowTransducer
environment.depth.belowSurface
environment.water.temperature
environment.outside.temperature
environment.outside.pressure
electrical.batteries.*.capacity.stateOfCharge
electrical.solar.*.power
```

Wildcards (`*`) are supported. Add or remove paths to match your vessel's instruments.

## REST API

All endpoints are relative to your SignalK server, e.g., `http://localhost:3000/plugins/voyage-log/`.

### `GET /plugins/voyage-log/status`

Returns current plugin status.

```json
{
  "logging": true,
  "logDir": "/home/pi/.signalk/voyage-logs",
  "logFiles": 12,
  "totalSizeMB": 45.23,
  "entriesThisSession": 8432,
  "voyageCount": 5,
  "underway": true,
  "currentVoyageId": "2025-06-15T08-30-00-000Z",
  "subscribedPaths": ["navigation.position", "..."]
}
```

### `GET /plugins/voyage-log/voyages`

Returns a list of all recorded voyages.

```json
[
  {
    "id": "2025-06-15T08-30-00-000Z",
    "start": "2025-06-15T08:30:00.000Z",
    "end": "2025-06-15T16:45:00.000Z",
    "distanceNm": 23.45,
    "pointCount": 1842
  }
]
```

### `GET /plugins/voyage-log/voyages/:id/gpx`

Downloads a GPX track file for the specified voyage. Returns `application/gpx+xml`.

### `GET /plugins/voyage-log/voyages/:id/csv`

Downloads a CSV summary for the specified voyage. Returns `text/csv`.

## File Formats

### JSONL Log Files

Each line is a JSON object:

```json
{"timestamp":"2025-06-15T08:30:10.000Z","path":"navigation.position","value":{"latitude":37.8044,"longitude":-122.2712},"source":"NMEA2000/GPS"}
{"timestamp":"2025-06-15T08:30:10.000Z","path":"navigation.speedOverGround","value":3.2,"source":"NMEA2000/GPS"}
```

Files are named `YYYY-MM-DD.jsonl` and stored in the configured log directory. If a file exceeds `maxFileSizeMB`, it is rotated with a timestamp suffix.

### GPX Format

Standard GPX 1.1 with a single track containing all position fixes during the voyage:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="signalk-voyage-log"
  xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Voyage 2025-06-15T08-30-00-000Z</name>
    <trkseg>
      <trkpt lat="37.8044" lon="-122.2712">
        <time>2025-06-15T08:30:10.000Z</time>
      </trkpt>
      ...
    </trkseg>
  </trk>
</gpx>
```

### CSV Format

Columns:

| Column | Unit | Source |
|--------|------|--------|
| `timestamp` | ISO 8601 | Log timestamp |
| `latitude` | Decimal degrees | `navigation.position` |
| `longitude` | Decimal degrees | `navigation.position` |
| `sog_kn` | Knots | `navigation.speedOverGround` (converted from m/s) |
| `cog_deg` | Degrees | `navigation.courseOverGroundTrue` (converted from radians) |
| `depth_m` | Meters | `environment.depth.belowTransducer` or `belowSurface` |
| `battery_soc` | Ratio (0-1) | `electrical.batteries.*.capacity.stateOfCharge` |
| `wind_speed_kn` | Knots | `environment.wind.speedApparent` (converted from m/s) |
| `wind_angle_deg` | Degrees | `environment.wind.angleApparent` (converted from radians) |

Empty cells indicate that data was not available for that path at that timestamp.

## Voyage Detection

The plugin automatically detects voyages based on speed over ground (SOG):

- **Start**: SOG exceeds `motionThreshold` (default 0.25 m/s = ~0.5 knots)
- **End**: SOG drops to or below the threshold

During a voyage, position fixes are recorded and distance is accumulated using the haversine formula. If the plugin is stopped mid-voyage, the voyage is ended automatically and resumed on restart if a previous voyage was still open.

## License

MIT
