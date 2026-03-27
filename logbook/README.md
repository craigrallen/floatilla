# signalk-logbook

Electronic logbook plugin for SignalK. Automatic entries from vessel data, manual entries via web UI and REST API, export to PDF and CSV.

## Features

- **Automatic entries**: departure/arrival detection, watch schedule, anchor set/weigh, engine on/off, shore power, weather changes
- **Manual entries**: add notes via the built-in web app or REST API
- **Export**: download logbook as PDF or CSV
- **Storage**: SQLite database via better-sqlite3
- **Web UI**: single-page timeline view with filtering and entry creation

## Installation

Install via the SignalK Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-logbook
```

Restart SignalK and enable the plugin in Server → Plugin Config.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| vesselName | My Vessel | Shown on PDF exports |
| watchInterval | 4 | Hours between automatic watch entries (0 to disable) |
| motionThreshold | 0.25 | SOG in m/s that triggers departure/arrival |
| logDir | (data dir)/logbook | Where the SQLite database is stored |
| autoEntries.* | true | Toggle each automatic entry type |

## REST API

All endpoints are under `/plugins/logbook/`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/entries` | List entries. Query params: `from`, `to` (ISO dates), `limit`, `offset` |
| POST | `/entries` | Create manual entry. JSON body with `category`, `notes`, `author`, etc. |
| DELETE | `/entries/:id` | Delete an entry |
| GET | `/export/csv` | Download CSV. Query params: `from`, `to` |
| GET | `/export/pdf` | Download PDF. Query params: `from`, `to` |

## Entry Categories

`departure`, `arrival`, `watch`, `anchor`, `engine`, `shore`, `weather`, `note`

## Web App

Access at `http://<signalk>:3000/plugins/logbook/` — view timeline, add entries, filter by date, export.

## License

MIT
