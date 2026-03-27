# Floatilla

**Open source boat monitoring, social networking, and safety plugin suite for SignalK**

Floatilla brings modern features to marine navigation systems, filling gaps left by traditional OpenCPN plugins. Built for SignalK, works with any boat — Victron, Mastervolt, NMEA2000, or basic GPS.

## Plugins

### 🔌 Core Data
- **victron-cerbo** — Victron Cerbo GX Modbus-TCP bridge (batteries, solar, tanks, grid via SignalK paths)
- **energy-manager** — Smart charging, solar forecasting, battery health tracking
- **voyage-log** — Automatic passage logging with GPX/CSV export (VDR replacement)
- **logbook** — Electronic logbook with auto-entries and PDF export

### 🌊 Social & Safety  
- **fleet-social** — Social network for boats: friends, messaging, shared waypoints, live positions on chart
- **mob** — Man overboard emergency system with NMEA output, webhooks, Floatilla network alerts
- **notify** — Daily vessel digest + threshold alerts via Discord/Telegram/webhooks

## Installation

Each plugin is a standard SignalK server plugin. Install via SignalK App Store or npm:

\`\`\`bash
cd ~/.signalk
npm install floatilla-victron-cerbo
\`\`\`

Or from this monorepo:
\`\`\`bash
git clone https://github.com/craigrallen/floatilla.git
cd floatilla/victron-cerbo
npm install
npm link
\`\`\`

## Architecture

All plugins work independently — mix and match what you need. They communicate via standard SignalK paths so data flows between them automatically.

## Self-Hosting

Fleet Social relay server can be self-hosted (Node.js + SQLite + WebSocket). Deploy to Railway/Fly.io in one click. See `fleet-social/server/README.md`.

## License

MIT

## Contributing

PRs welcome. Each plugin has its own README with contribution guidelines.

---

**Floatilla** = Flotilla + AI-powered boat intelligence 🚢
