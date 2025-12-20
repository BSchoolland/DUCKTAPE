import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'monitor.db');

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize schema
export function initializeDatabase() {
  // Projects table - stores URL monitoring configurations per guild and channel
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      alert_channel_id TEXT,
      failure_threshold INTEGER DEFAULT 3,
      check_interval_sec INTEGER DEFAULT 300,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, name)
    );
  `);

  // Project status - tracks current health of each project
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_status (
      project_id INTEGER PRIMARY KEY,
      is_up INTEGER DEFAULT 1,
      consecutive_failures INTEGER DEFAULT 0,
      last_status_code INTEGER,
      last_checked_at DATETIME,
      last_alert_sent_at DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // Uptime checks - historical log for generating graphs
  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status_code INTEGER,
      is_up INTEGER,
      response_time_ms INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  // Personality traits - global traits set by users
  db.exec(`
    CREATE TABLE IF NOT EXISTS personality_traits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT,
      trait TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_guild ON projects(guild_id);
    CREATE INDEX IF NOT EXISTS idx_projects_channel ON projects(channel_id);
    CREATE INDEX IF NOT EXISTS idx_uptime_checks_project ON uptime_checks(project_id);
    CREATE INDEX IF NOT EXISTS idx_uptime_checks_time ON uptime_checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_personality_traits_user ON personality_traits(user_id);
  `);
}

// Project operations
export function createProject(guildId, channelId, name, url, failureThreshold = 3, checkIntervalSec = 300) {
  const stmt = db.prepare(`
    INSERT INTO projects (guild_id, channel_id, name, url, failure_threshold, check_interval_sec)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(guildId, channelId, name, url, failureThreshold, checkIntervalSec);
  const projectId = result.lastInsertRowid;

  // Initialize status
  const statusStmt = db.prepare(`
    INSERT INTO project_status (project_id, is_up, consecutive_failures)
    VALUES (?, 1, 0)
  `);
  statusStmt.run(projectId);

  return projectId;
}

export function getProjectsByGuild(guildId) {
  const stmt = db.prepare(`
    SELECT * FROM projects WHERE guild_id = ? AND is_active = 1
  `);
  return stmt.all(guildId);
}

export function getProjectsByChannel(guildId, channelId) {
  const stmt = db.prepare(`
    SELECT * FROM projects WHERE guild_id = ? AND channel_id = ? AND is_active = 1
  `);
  return stmt.all(guildId, channelId);
}

export function getProjectById(projectId) {
  const stmt = db.prepare(`
    SELECT * FROM projects WHERE id = ?
  `);
  return stmt.get(projectId);
}

export function getAllActiveProjects() {
  const stmt = db.prepare(`
    SELECT * FROM projects WHERE is_active = 1
  `);
  return stmt.all();
}

export function deleteProject(projectId) {
  const stmt = db.prepare(`
    UPDATE projects SET is_active = 0 WHERE id = ?
  `);
  return stmt.run(projectId);
}

export function setAlertChannel(projectId, alertChannelId) {
  const stmt = db.prepare(`
    UPDATE projects SET alert_channel_id = ? WHERE id = ?
  `);
  return stmt.run(alertChannelId, projectId);
}

// Status operations
export function getProjectStatus(projectId) {
  const stmt = db.prepare(`
    SELECT * FROM project_status WHERE project_id = ?
  `);
  return stmt.get(projectId);
}

export function updateProjectStatus(projectId, isUp, statusCode, responseTimeMs = null) {
  const currentStatus = getProjectStatus(projectId);
  let consecutiveFailures = currentStatus.consecutive_failures;

  if (isUp) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures += 1;
  }

  const stmt = db.prepare(`
    UPDATE project_status
    SET is_up = ?, consecutive_failures = ?, last_status_code = ?, last_checked_at = CURRENT_TIMESTAMP
    WHERE project_id = ?
  `);
  
  stmt.run(isUp ? 1 : 0, consecutiveFailures, statusCode, projectId);

  return {
    wasUp: currentStatus.is_up === 1,
    isNowUp: isUp,
    consecutiveFailures,
  };
}

export function logUptime(projectId, isUp, statusCode, responseTimeMs = null) {
  const stmt = db.prepare(`
    INSERT INTO uptime_checks (project_id, is_up, status_code, response_time_ms)
    VALUES (?, ?, ?, ?)
  `);
  
  stmt.run(projectId, isUp ? 1 : 0, statusCode, responseTimeMs);
}

export function recordAlertSent(projectId) {
  const stmt = db.prepare(`
    UPDATE project_status SET last_alert_sent_at = CURRENT_TIMESTAMP WHERE project_id = ?
  `);
  stmt.run(projectId);
}

// Uptime data retrieval
export function getUptimeForLast7Days(projectId) {
  const stmt = db.prepare(`
    SELECT * FROM uptime_checks
    WHERE project_id = ? AND checked_at > datetime('now', '-7 days')
    ORDER BY checked_at ASC
  `);
  return stmt.all(projectId);
}

export function getRecentUptimeChecks(projectId, hoursAgo) {
  const stmt = db.prepare(`
    SELECT * FROM uptime_checks
    WHERE project_id = ? AND checked_at > datetime('now', '-${hoursAgo} hours')
    ORDER BY checked_at ASC
  `);
  return stmt.all(projectId);
}

export function getUptimeForLast3Hours(projectId) {
  return getRecentUptimeChecks(projectId, 3);
}

export function getUptimeStats(projectId) {
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as total_checks,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) as successful_checks,
      AVG(response_time_ms) as avg_response_time
    FROM uptime_checks
    WHERE project_id = ? AND checked_at > datetime('now', '-7 days')
  `);
  const result = stmt.get(projectId);
  
  if (result && result.total_checks > 0) {
    return {
      uptime_percentage: (result.successful_checks / result.total_checks * 100).toFixed(2),
      total_checks: result.total_checks,
      successful_checks: result.successful_checks,
      avg_response_time: result.avg_response_time ? Math.round(result.avg_response_time) : null,
    };
  }
  
  return null;
}

// Personality traits operations
export function setUserPersonalityTrait(userId, username, trait) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO personality_traits (user_id, username, trait)
    VALUES (?, ?, ?)
  `);
  return stmt.run(userId, username, trait);
}

export function getAllPersonalityTraits() {
  const stmt = db.prepare(`
    SELECT trait FROM personality_traits
    ORDER BY created_at ASC
  `);
  return stmt.all().map(row => row.trait);
}

export default db;

