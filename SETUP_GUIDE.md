# Ducktape Discord Bot - Setup & Usage Guide

## Overview

Ducktape is a Discord bot that monitors project uptime and sends alerts when services go down. It now includes:

- **Multi-server support** with per-server project configuration
- **Channel-scoped monitoring** - each project belongs to a specific channel but can send alerts anywhere
- **Periodic URL checks** with configurable intervals and failure thresholds
- **Automated alerts** when services go down and when they recover
- **Uptime graphs** showing status over the last 7 days
- **AI chat** (preserved from original) for casual interaction

## New Features

### 1. Project Management

**Add a project**: `/ducktape_add_project`
- Opens a modal asking for:
  - Project name (must be unique per server)
  - URL to monitor (must be valid)
  - Check interval in seconds (minimum 10s, default 300s)
  - Failure threshold (consecutive failures before alerting, default 3)

**List projects**: `/ducktape_list_projects`
- Shows all monitored projects in the current server
- Displays ownership, alert channel, and configuration

**Remove project**: `/ducktape_remove_project [project_name]`
- Stops monitoring a project and removes its history

### 2. Alert Configuration

**Set alert channel**: `/ducktape_here [optional: project_name]`
- If no project is specified, configures alerts for all projects in the current channel
- If a project name is specified, configures alerts just for that project
- Allows multi-select if multiple projects match

**Alert behavior**:
- Bot waits for N consecutive failures (configurable per project)
- Sends alert when threshold is reached with status code or error type
- Sends recovery message when service comes back up
- All alerts are **non-AI** automated messages with clear status information

### 3. Status Monitoring

**View status**: `/ducktape_status`
- Generates a visual graph of uptime over the last 7 days (if canvas is available)
- Shows uptime percentage per project
- Color-coded: green for up, red for down
- Falls back to text summary if image generation fails

## Database Schema

The bot uses **SQLite** (`monitor.db`) with three tables:

### `projects` table
```
id                  INTEGER PRIMARY KEY
guild_id            TEXT (server identifier)
channel_id          TEXT (owning channel)
name                TEXT (unique per guild)
url                 TEXT (monitoring target)
alert_channel_id    TEXT (where alerts are sent, optional)
failure_threshold   INTEGER (consecutive failures before alert)
check_interval_sec  INTEGER (seconds between checks)
is_active           INTEGER (soft delete flag)
created_at          DATETIME
```

### `project_status` table
```
project_id              INTEGER PRIMARY KEY
is_up                   INTEGER (current health)
consecutive_failures    INTEGER (for threshold logic)
last_status_code        INTEGER (HTTP response code)
last_checked_at         DATETIME
last_alert_sent_at      DATETIME
```

### `uptime_checks` table
```
id                INTEGER PRIMARY KEY
project_id        INTEGER
checked_at        DATETIME
status_code       INTEGER
is_up             INTEGER
response_time_ms  INTEGER
```

## Installation & Setup

### 1. Install Dependencies

```bash
npm install
```

This installs:
- `discord.js` - Discord bot framework
- `better-sqlite3` - Fast, synchronous SQLite access
- `canvas` - For generating uptime graphs (requires system dependencies)
- `dotenv` - Environment variable management
- `@openrouter/sdk` - AI integration (for chat feature)

### 2. Environment Variables

Create a `.env` file with:
```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_app_id
OPENROUTER_API_KEY=your_openrouter_key (for chat)
```

### 3. Register Slash Commands

```bash
node register-commands.js
```

This registers all commands globally with Discord. Must be re-run if you change command definitions.

### 4. Start the Bot

```bash
node index.js
```

The bot will:
1. Connect to Discord
2. Initialize the SQLite database (creates tables if needed)
3. Load all active projects from the database
4. Start background timers for each project

## How It Works

### Periodic Checks

1. Bot starts and loads all active projects from the database
2. For each project, a `setInterval` timer is created using its configured `check_interval_sec`
3. Every interval:
   - Perform HTTP GET request to the project URL (10-second timeout)
   - Record result in `uptime_checks` table
   - Update `project_status` with current health
   - If status changes or threshold is reached, send an alert

### Multi-Server Isolation

All database operations are scoped by `guild_id`:
- Creating a project in Server A stores `guild_id = ServerA_ID`
- Listing projects for Server B only queries `WHERE guild_id = ServerB_ID`
- Alerts only go to channels within the correct guild
- No data leakage between servers

### Channel Scoping

Each project "belongs" to the channel where `/ducktape_add_project` was invoked:
- Stored in `projects.channel_id`
- By default, alerts go to this owning channel
- Can be overridden with `/ducktape_here` to redirect alerts elsewhere
- Useful for organizing alerts by team or purpose

## File Structure

```
my-discord-bot/
├── index.js              # Main bot entry point
├── aiHandler.js          # AI chat (unchanged)
├── messageUtils.js       # Message splitting utility
├── db.js                 # SQLite database module
├── scheduler.js          # Periodic check scheduler
├── statusGraph.js        # Graph generation for status command
├── commands.js           # All slash command handlers
├── register-commands.js  # Command registration utility
├── package.json          # Dependencies
└── monitor.db            # SQLite database (auto-created)
```

## Usage Examples

### Monitor a Website

```
/ducktape_add_project
Project Name: My API
URL: https://api.example.com
Check Interval: 300 (every 5 min)
Failure Threshold: 3 (alert after 3 failures)
```

### Get Alerts in Specific Channel

After creating a project:
```
/ducktape_here project:My API
```

### View All Monitored Services

```
/ducktape_status
```

Shows a graph or text summary of all services in the server.

## Scheduler Behavior

The scheduler runs in-process within the Discord bot:
- **Pro**: Simple, no external service needed
- **Con**: Restarts reset counters (but DB is persistent)
- New projects are added to the scheduler immediately without restarting
- Projects marked as inactive are no longer checked

## Error Handling

- **Invalid URL**: Modal will reject and ask for correction
- **Network errors**: Recorded as "is_up = false", counts toward threshold
- **Timeouts**: Treated as service down (10-second timeout)
- **Status codes other than 200**: Treated as service down
- **Graph generation failure**: Falls back to text summary
- **Missing alert channel**: Error logged, alert not sent

## Next Steps & Improvements

Optional future enhancements:
- Autocomplete for project names in commands
- Dashboard showing real-time status
- Webhook integration for external uptime services
- More sophisticated graph options (hourly, daily stats)
- Status page generation
- Notification preferences per user

