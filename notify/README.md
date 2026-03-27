# signalk-notify

A SignalK server plugin that sends configurable vessel status notifications and alerts via webhooks. Supports Discord, Telegram, Slack, and generic HTTP endpoints.

## Features

- **Daily Digest** — Scheduled summary of vessel status: battery, solar, tanks, position, weather, alarms
- **Threshold Alerts** — Immediate notifications for battery SoC, low tanks, anchor drag, high bilge
- **Custom Alerts** — User-defined path + operator + value conditions with cooldowns
- **Multi-platform** — Discord (rich embeds), Telegram (Markdown), Slack (attachments), generic JSON webhooks

## Installation

Install via the SignalK Appstore, or manually:

```bash
cd ~/.signalk
npm install signalk-notify
```

Then restart SignalK and enable the plugin in **Server → Plugin Config → SignalK Notify**.

## Webhook Setup

### Discord

1. Open your Discord server, go to **Server Settings → Integrations → Webhooks**
2. Click **New Webhook**, choose a channel, and copy the webhook URL
3. In the plugin config, add a webhook:
   - **Type:** `discord`
   - **URL:** `https://discord.com/api/webhooks/XXXX/YYYY`
   - **Events:** `all` (or pick `digest` / `alert`)

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot with `/newbot`
2. Copy the bot token (e.g. `123456:ABC-DEF...`)
3. Start a chat with your bot, then get your chat ID by visiting:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. In the plugin config, add a webhook:
   - **Type:** `telegram`
   - **URL:** `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>`
   - **Events:** `all`

### Slack

1. Go to [Slack Apps](https://api.slack.com/apps) and create a new app (or use an existing one)
2. Under **Incoming Webhooks**, activate and add a new webhook to your workspace
3. Copy the webhook URL
4. In the plugin config, add a webhook:
   - **Type:** `slack`
   - **URL:** `https://hooks.slack.com/services/T.../B.../XXXX`
   - **Events:** `all`

### Generic HTTP

1. Use any endpoint that accepts `POST` with `Content-Type: application/json`
2. In the plugin config, add a webhook:
   - **Type:** `generic`
   - **URL:** your endpoint URL
   - **Events:** `all`
3. Optionally provide a **Custom JSON Template** with `{{variable}}` placeholders:
   - `{{batterySocPct}}`, `{{batteryVoltage}}`, `{{batteryState}}`
   - `{{solarYesterdayKwh}}`, `{{solarTodayKwh}}`
   - `{{locationName}}`, `{{latitude}}`, `{{longitude}}`
   - `{{weather}}`, `{{depth}}`, `{{dateFormatted}}`, `{{timestamp}}`
   - `{{tank_0_name}}`, `{{tank_0_pct}}`, etc.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `digestEnabled` | `true` | Enable/disable the daily digest |
| `digestTime` | `08:00` | Time to send digest (HH:MM, local) |
| `alertsEnabled` | `true` | Enable/disable threshold alerts |
| `thresholds.batterySoCLow` | `20` | Battery % below which to alert |
| `thresholds.batterySoCHigh` | `95` | Battery % above which to alert |
| `thresholds.tankLow` | `15` | Tank % below which to alert |
| `timezone` | `UTC` | IANA timezone (e.g. `Europe/Stockholm`) |

### Custom Alerts

Add custom alerts with:
- **path** — Any SignalK path (e.g. `environment.outside.temperature`)
- **operator** — `<`, `<=`, `>`, `>=`, `==`, `!=`
- **value** — Numeric threshold (in SignalK units)
- **message** — Custom alert text
- **cooldownMinutes** — Minimum time between repeated alerts (default: 30)

## Example Discord Message

```
🚢 Vessel Status — Fri 27 Mar 08:00

🔋 Battery: 78% — Charging (shore power) | 27.4V | +45A
☀️ Solar: Yesterday 2.3kWh | Today 0.4kWh
💧 Fresh water: 65% (325L)
📍 Position: Riddarholmen, Stockholm
🌤️ Weather: 18.2°C | 62% humidity | 1013 hPa | Wind 8.5 kts
```

## SignalK Paths Used

- `electrical.batteries.house.*` — Battery state of charge, voltage, current
- `electrical.solar.*` — Solar panel power and lifetime energy
- `electrical.ac.shore.state` — Shore power detection
- `tanks.*` — All tank types and levels
- `environment.depth.belowTransducer` — Depth
- `navigation.position` — GPS position
- `navigation.anchor.*` — Anchor position and max radius
- `environment.outside.*` — Temperature, humidity, pressure
- `environment.wind.speedApparent` — Wind speed
- `notifications.*` — Active alarms
- `tanks.bilge.*` — Bilge level

## License

MIT
