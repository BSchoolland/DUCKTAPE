import {
  getAllActiveProjects,
  getProjectStatus,
  updateProjectStatus,
  logUptime,
  recordAlertSent,
  getProjectById,
} from './db.js';
import { formatMessageHistory, getAIResponse } from './aiHandler.js';
import { splitMessage } from './messageUtils.js';

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
  let responseBody = null;

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

    // Capture response body for DOWN alerts (truncated to 3000 chars)
    if (!isUp) {
      try {
        const fullBody = await response.text();
        responseBody = fullBody.substring(0, 3000);
      } catch (bodyErr) {
        console.log(`⚠️ Could not read response body for ${project.name}: ${bodyErr.message}`);
        responseBody = null;
      }
    }

    clearTimeout(timeoutId);
  } catch (err) {
    responseTimeMs = Date.now() - startTime;
    isUp = false;
    statusCode = null; // Timeout or network error
    console.log(`⚠️ Error checking ${project.name}: ${err.message}`);
  }

  // Get previous status BEFORE updating, so we can see how bad things were
  const previousStatus = getProjectStatus(project.id);

  // Log the check
  logUptime(project.id, isUp, statusCode, responseTimeMs);

  // Update status and check for alerts
  const statusChange = updateProjectStatus(project.id, isUp, statusCode, responseTimeMs);

  // Handle state changes and alert thresholds
  // Compute when to send DOWN alerts:
  // - First alert when failures reach failure_threshold
  // - Second alert 30 minutes of continuous failures later:
  //   at failure_threshold + int(1800 / check_interval_sec)
  const checksPer30Min = Math.floor(1800 / project.check_interval_sec);
  const secondFailureThreshold =
    checksPer30Min > 0 ? project.failure_threshold + checksPer30Min : null;

  const hadReachedFailureThreshold =
    previousStatus &&
    typeof previousStatus.consecutive_failures === 'number' &&
    previousStatus.consecutive_failures >= project.failure_threshold;

  // DOWN alerts
  if (
    !isUp &&
    (
      statusChange.consecutiveFailures === project.failure_threshold ||
      (secondFailureThreshold !== null &&
        statusChange.consecutiveFailures === secondFailureThreshold)
    )
  ) {
    await sendAlert(project, 'DOWN', statusCode, statusChange.consecutiveFailures, responseBody);
    recordAlertSent(project.id);
  } else if (isUp && !statusChange.wasUp && hadReachedFailureThreshold) {
    // Service recovered after actually being considered DOWN (hit threshold at some point)
    await sendAlert(project, 'RECOVERED', statusCode, 0, null);
    recordAlertSent(project.id);
  }
}

// Send alert message to Discord
async function sendAlert(project, status, statusCode, consecutiveFailures, responseBody = null) {
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

    // If service went DOWN, trigger AI explanation
    if (status === 'DOWN') {
      try {
        await generateAndPostAIExplanation(project, statusCode, responseBody, channel);
      } catch (aiErr) {
        console.error(`Failed to generate AI explanation for ${project.name}:`, aiErr);
        // Don't break the alert flow if AI fails
      }
    }
  } catch (err) {
    console.error(`Failed to send alert for project ${project.id}:`, err);
  }
}

// Generate and post AI explanation for DOWN service
async function generateAndPostAIExplanation(project, statusCode, responseBody, channel) {
  try {
    // Build status summary for all projects
    const allProjects = getAllActiveProjects();
    let statusSummary = 'Current service statuses:\n';
    
    for (const p of allProjects) {
      const status = getProjectStatus(p.id);
      const statusEmoji = status.is_up ? '🟢' : '🔴';
      const statusText = status.is_up ? 'UP' : 'DOWN';
      statusSummary += `${statusEmoji} ${p.name}: ${statusText}`;
      if (!status.is_up && status.last_status_code) {
        statusSummary += ` (Status: ${status.last_status_code})`;
      }
      statusSummary += '\n';
    }

    // Build DUCKTAPE SYSTEM context message
    const responseInfo = responseBody 
      ? `Response body (truncated):\n\`\`\`\n${responseBody}\n\`\`\`` 
      : 'Response body: [No response body captured - likely timeout or network error]';

    const systemMessage = `[DUCKTAPE SYSTEM at ${new Date().toLocaleTimeString()}] Service ${project.name} has gone DOWN!

${statusSummary}

Failed service details:
- URL: ${project.url}
- Status Code: ${statusCode || 'Timeout/Network Error'}
- ${responseInfo}

Please provide a brief, witty analysis of why this service might be down and what we should check.`;

    // Fetch message history from the channel
    let history = [];
    try {
      const fetchedMessages = await channel.messages.fetch({ limit: 100 });
      history = formatMessageHistory(Array.from(fetchedMessages.values()), client.user.id);
    } catch (fetchErr) {
      console.warn(`Could not fetch channel history for ${project.name}:`, fetchErr.message);
      // Continue with empty history if fetch fails
      history = [];
    }

    // Append DUCKTAPE SYSTEM message to history
    history.push({
      role: 'user',
      content: systemMessage,
    });

    // Get AI response
    const aiReply = await getAIResponse(history);

    if (aiReply) {
      // Split message if it exceeds Discord's 2000 character limit
      if (aiReply.length <= 2000) {
        await channel.send(aiReply);
      } else {
        const chunks = splitMessage(aiReply);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
      console.log(`✨ AI explanation posted for ${project.name}`);
    }
  } catch (err) {
    console.error(`Error generating AI explanation for ${project.name}:`, err);
    // Silently fail - don't break the scheduler
  }
}

export default {
  initializeScheduler,
  startScheduler,
  stopScheduler,
  addProject,
};

