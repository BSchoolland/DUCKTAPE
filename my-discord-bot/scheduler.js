import {
  getAllActiveProjects,
  getProjectStatus,
  updateProjectStatus,
  logUptime,
  recordAlertSent,
  getProjectById,
} from './db.js';

const timers = new Map(); // Store timers by project ID for cleanup
let client = null; // Reference to Discord client

// Setup scheduler with Discord client reference
export function initializeScheduler(discordClient) {
  client = discordClient;
}

// Start checking all projects
export function startScheduler() {
  const projects = getAllActiveProjects();
  
  console.log(`🔄 Starting scheduler for ${projects.length} projects`);
  
  for (const project of projects) {
    scheduleProjectCheck(project);
  }
}

// Schedule a single project's periodic checks
function scheduleProjectCheck(project) {
  // Clear existing timer if any
  if (timers.has(project.id)) {
    clearInterval(timers.get(project.id));
  }

  // Run first check immediately
  checkProject(project).catch(err => {
    console.error(`Error checking project ${project.id}:`, err);
  });

  // Schedule recurring checks
  const intervalId = setInterval(() => {
    checkProject(project).catch(err => {
      console.error(`Error checking project ${project.id}:`, err);
    });
  }, project.check_interval_sec * 1000);

  timers.set(project.id, intervalId);
}

// Add a new project to scheduler without restarting
export function addProject(projectId) {
  const project = getProjectById(projectId);
  if (project) {
    scheduleProjectCheck(project);
    console.log(`✅ Added project ${projectId} to scheduler`);
  }
}

// Stop scheduler
export function stopScheduler() {
  for (const [projectId, intervalId] of timers.entries()) {
    clearInterval(intervalId);
  }
  timers.clear();
  console.log('⏹️ Scheduler stopped');
}

// Check a single project's URL
async function checkProject(project) {
  const startTime = Date.now();
  let isUp = false;
  let statusCode = null;
  let responseTimeMs = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(project.url, {
      method: 'GET',
      signal: controller.signal,
    });

    responseTimeMs = Date.now() - startTime;
    statusCode = response.status;
    isUp = statusCode === 200;

    clearTimeout(timeoutId);
  } catch (err) {
    responseTimeMs = Date.now() - startTime;
    isUp = false;
    statusCode = null; // Timeout or network error
    console.log(`⚠️ Error checking ${project.name}: ${err.message}`);
  }

  // Log the check
  logUptime(project.id, isUp, statusCode, responseTimeMs);

  // Update status and check for alerts
  const statusChange = updateProjectStatus(project.id, isUp, statusCode, responseTimeMs);
  const currentStatus = getProjectStatus(project.id);

  // Handle state changes and alert thresholds
  if (statusChange.wasUp && !statusChange.isNowUp) {
    // Service went down
    if (currentStatus.consecutive_failures === project.failure_threshold) {
      await sendAlert(project, 'DOWN', statusCode, statusChange.consecutiveFailures);
      recordAlertSent(project.id);
    }
  } else if (!statusChange.wasUp && statusChange.isNowUp) {
    // Service recovered
    await sendAlert(project, 'RECOVERED', statusCode, 0);
    recordAlertSent(project.id);
  }
}

// Send alert message to Discord
async function sendAlert(project, status, statusCode, consecutiveFailures) {
  if (!client || !client.isReady()) {
    console.error('Discord client not ready for sending alerts');
    return;
  }

  const channelId = project.alert_channel_id || project.channel_id;

  try {
    const channel = await client.channels.fetch(channelId);
    
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel ${channelId} not found or not text-based`);
      return;
    }

    let message = '';
    let color = 0xff0000; // Red for down

    if (status === 'DOWN') {
      color = 0xff0000; // Red
      message = `🔴 **${project.name}** is DOWN\n`;
      message += `URL: ${project.url}\n`;
      message += `Status Code: ${statusCode || 'Timeout/Network Error'}\n`;
      message += `Consecutive Failures: ${consecutiveFailures}/${project.failure_threshold}`;
    } else if (status === 'RECOVERED') {
      color = 0x00ff00; // Green
      message = `🟢 **${project.name}** is BACK UP\n`;
      message += `URL: ${project.url}\n`;
      message += `Status Code: ${statusCode}`;
    }

    await channel.send({
      embeds: [
        {
          color,
          title: status === 'DOWN' ? '⚠️ SERVICE ALERT' : '✅ SERVICE RECOVERED',
          description: message,
          timestamp: new Date(),
          footer: {
            text: 'Ducktape Monitor',
          },
        },
      ],
    });

    console.log(`📢 Alert sent for ${project.name}: ${status}`);
  } catch (err) {
    console.error(`Failed to send alert for project ${project.id}:`, err);
  }
}

export default {
  initializeScheduler,
  startScheduler,
  stopScheduler,
  addProject,
};

