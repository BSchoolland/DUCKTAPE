/**
 * Vulnerability Scheduler Module
 * Handles daily vulnerability scans at 8AM and on-demand scans
 * Sends alerts for new HIGH/CRITICAL vulnerabilities and resolved ones
 */

import {
  getAllActiveProjects,
  getProjectById,
  getActiveCVEsForProject,
  saveCVEs,
  markCVEsResolved,
} from './db.js';
import { scanUrl, getVulnCounts, getHighAndCritical } from './vulnScanner.js';
import { formatMessageHistory, getAIResponse } from './aiHandler.js';
import { splitMessage } from './messageUtils.js';

let client = null;
let dailyTimer = null;

/**
 * Initialize the vulnerability scheduler with Discord client reference
 * @param {Client} discordClient - Discord.js client
 */
export function initializeVulnScheduler(discordClient) {
  client = discordClient;
}

/**
 * Start the daily 8AM vulnerability scan scheduler
 */
export function startVulnScheduler() {
  // Calculate time until next 8AM
  const now = new Date();
  const next8AM = new Date(now);
  next8AM.setHours(8, 0, 0, 0);
  
  // If it's already past 8AM today, schedule for tomorrow
  if (now >= next8AM) {
    next8AM.setDate(next8AM.getDate() + 1);
  }
  
  const msUntil8AM = next8AM.getTime() - now.getTime();
  
  console.log(`🔒 Vulnerability scheduler: next scan at ${next8AM.toLocaleString()}`);
  
  // Schedule the first run
  dailyTimer = setTimeout(() => {
    runDailyVulnScan();
    // Then run every 24 hours
    dailyTimer = setInterval(runDailyVulnScan, 24 * 60 * 60 * 1000);
  }, msUntil8AM);
}

/**
 * Stop the vulnerability scheduler
 */
export function stopVulnScheduler() {
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
  console.log('⏹️ Vulnerability scheduler stopped');
}

/**
 * Run daily vulnerability scan for all projects (staggered)
 */
async function runDailyVulnScan() {
  console.log('🔒 Starting daily vulnerability scan...');
  
  const projects = getAllActiveProjects();
  
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    
    try {
      await checkProjectVulnerabilities(project);
    } catch (err) {
      console.error(`Vulnerability scan failed for ${project.name}:`, err);
    }
    
    // Stagger scans to avoid rate limiting (30 seconds between projects)
    if (i < projects.length - 1) {
      await sleep(30000);
    }
  }
  
  console.log('🔒 Daily vulnerability scan complete');
}

/**
 * Trigger vulnerability check for a single project (on-demand)
 * @param {number} projectId - Project ID to scan
 */
export async function triggerVulnCheck(projectId) {
  const project = getProjectById(projectId);
  if (!project) {
    console.error(`Project ${projectId} not found for vulnerability check`);
    return;
  }
  
  try {
    await checkProjectVulnerabilities(project);
  } catch (err) {
    console.error(`Vulnerability scan failed for ${project.name}:`, err);
  }
}

/**
 * Scan all projects for a specific guild now
 * @param {string} guildId - Discord guild ID
 * @param {object} interaction - Discord interaction for progress updates
 */
export async function scanGuildProjectsNow(guildId, interaction) {
  const projects = getAllActiveProjects().filter(p => p.guild_id === guildId);
  
  if (projects.length === 0) {
    return { scanned: 0, vulnerabilities: 0 };
  }
  
  let totalVulns = 0;
  
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    
    try {
      const result = await checkProjectVulnerabilities(project);
      if (result) {
        totalVulns += result.newAlerts + result.criticalAlerts;
      }
    } catch (err) {
      console.error(`Vulnerability scan failed for ${project.name}:`, err);
    }
    
    // Small delay between projects
    if (i < projects.length - 1) {
      await sleep(5000);
    }
  }
  
  return { scanned: projects.length, vulnerabilities: totalVulns };
}

/**
 * Check a single project for vulnerabilities and send alerts
 * @param {object} project - Project object from database
 * @returns {object|null} - Scan results or null if failed
 */
async function checkProjectVulnerabilities(project) {
  console.log(`🔍 Scanning vulnerabilities for ${project.name}...`);
  
  let scanResult;
  try {
    scanResult = await scanUrl(project.url);
  } catch (err) {
    console.error(`Failed to scan ${project.name}: ${err.message}`);
    return null;
  }
  
  const currentVulns = scanResult.vulnerabilities;
  const storedCVEs = getActiveCVEsForProject(project.id);
  
  // Build sets for comparison
  const currentCVEIds = new Set(currentVulns.map(v => v.cve));
  const storedCVEIds = new Set(storedCVEs.map(v => v.cve_id));
  
  // Find NEW vulnerabilities (not in stored)
  const newVulns = currentVulns.filter(v => !storedCVEIds.has(v.cve));
  
  // Find RESOLVED vulnerabilities (in stored but not current)
  const resolvedCVEIds = storedCVEs
    .filter(v => !currentCVEIds.has(v.cve_id))
    .map(v => v.cve_id);
  
  // Get resolved HIGH+ for alerting
  const resolvedHighPlus = storedCVEs
    .filter(v => !currentCVEIds.has(v.cve_id) && (v.severity === 'HIGH' || v.severity === 'CRITICAL'));
  
  // Filter new vulns to HIGH and CRITICAL only for alerting
  const newHighVulns = newVulns.filter(v => v.severity === 'HIGH');
  const newCriticalVulns = newVulns.filter(v => v.severity === 'CRITICAL');
  
  // All current CRITICAL vulns (for always alerting)
  const allCurrentCritical = currentVulns.filter(v => v.severity === 'CRITICAL');
  
  // Save new CVEs to database
  if (newVulns.length > 0) {
    saveCVEs(project.id, newVulns);
  }
  
  // Mark resolved CVEs
  if (resolvedCVEIds.length > 0) {
    markCVEsResolved(project.id, resolvedCVEIds);
  }
  
  // Determine if we need to alert
  const shouldAlert = 
    newHighVulns.length > 0 || 
    newCriticalVulns.length > 0 || 
    resolvedHighPlus.length > 0;
  
  if (shouldAlert) {
    await sendVulnAlert(project, {
      newHigh: newHighVulns,
      newCritical: newCriticalVulns,
      allCritical: allCurrentCritical,
      resolved: resolvedHighPlus,
      totalNew: newVulns.length,
      totalCurrent: currentVulns.length,
    });
  }
  
  const counts = getVulnCounts(currentVulns);
  console.log(`📊 ${project.name}: ${counts.total} total (${counts.critical} critical, ${counts.high} high)`);
  
  return {
    newAlerts: newHighVulns.length + newCriticalVulns.length,
    criticalAlerts: allCurrentCritical.length,
    resolved: resolvedHighPlus.length,
  };
}

/**
 * Send vulnerability alert to Discord
 * @param {object} project - Project object
 * @param {object} alertData - Alert data with new/resolved vulns
 */
async function sendVulnAlert(project, alertData) {
  if (!client || !client.isReady()) {
    console.error('Discord client not ready for sending vuln alerts');
    return;
  }
  
  const channelId = project.alert_channel_id || project.channel_id;
  
  try {
    const channel = await client.channels.fetch(channelId);
    
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel ${channelId} not found or not text-based`);
      return;
    }
    
    // Build the embed
    const embed = {
      color: alertData.newCritical.length > 0 ? 0xff0000 : 0xffa500, // Red for critical, orange for high
      title: `🔒 Security Alert: ${project.name}`,
      description: `Vulnerability scan detected security issues for **${project.name}**\n${project.url}`,
      fields: [],
      timestamp: new Date(),
      footer: {
        text: 'Ducktape Vulnerability Scanner',
      },
    };
    
    // New CRITICAL vulnerabilities
    if (alertData.newCritical.length > 0) {
      const criticalList = alertData.newCritical.slice(0, 5).map(v => 
        `🔴 [${v.cve}](${v.url}) - ${v.technology} v${v.version} (CVSS: ${v.cvss})`
      ).join('\n');
      
      embed.fields.push({
        name: `🚨 NEW CRITICAL Vulnerabilities (${alertData.newCritical.length})`,
        value: criticalList + (alertData.newCritical.length > 5 ? `\n... and ${alertData.newCritical.length - 5} more` : ''),
        inline: false,
      });
    }
    
    // New HIGH vulnerabilities
    if (alertData.newHigh.length > 0) {
      const highList = alertData.newHigh.slice(0, 5).map(v => 
        `🟠 [${v.cve}](${v.url}) - ${v.technology} v${v.version} (CVSS: ${v.cvss})`
      ).join('\n');
      
      embed.fields.push({
        name: `⚠️ NEW HIGH Vulnerabilities (${alertData.newHigh.length})`,
        value: highList + (alertData.newHigh.length > 5 ? `\n... and ${alertData.newHigh.length - 5} more` : ''),
        inline: false,
      });
    }
    
    // All current CRITICAL (always show, even if not new)
    if (alertData.allCritical.length > 0 && alertData.newCritical.length === 0) {
      const criticalList = alertData.allCritical.slice(0, 3).map(v => 
        `🔴 [${v.cve}](${v.url}) - ${v.technology} v${v.version}`
      ).join('\n');
      
      embed.fields.push({
        name: `⚠️ Active CRITICAL Vulnerabilities (${alertData.allCritical.length})`,
        value: criticalList + (alertData.allCritical.length > 3 ? `\n... and ${alertData.allCritical.length - 3} more` : ''),
        inline: false,
      });
    }
    
    // Resolved vulnerabilities
    if (alertData.resolved.length > 0) {
      const resolvedList = alertData.resolved.slice(0, 3).map(v => 
        `✅ ${v.cve_id} - ${v.technology} (was ${v.severity})`
      ).join('\n');
      
      embed.fields.push({
        name: `🎉 Resolved Vulnerabilities (${alertData.resolved.length})`,
        value: resolvedList + (alertData.resolved.length > 3 ? `\n... and ${alertData.resolved.length - 3} more` : ''),
        inline: false,
      });
    }
    
    await channel.send({ embeds: [embed] });
    console.log(`📢 Vulnerability alert sent for ${project.name}`);
    
    // Generate AI explanation
    try {
      await generateVulnAIExplanation(project, alertData, channel);
    } catch (aiErr) {
      console.error(`Failed to generate AI explanation for ${project.name}:`, aiErr);
    }
    
  } catch (err) {
    console.error(`Failed to send vuln alert for project ${project.id}:`, err);
  }
}

/**
 * Generate and post AI explanation for vulnerability alert
 * @param {object} project - Project object
 * @param {object} alertData - Alert data
 * @param {object} channel - Discord channel
 */
async function generateVulnAIExplanation(project, alertData, channel) {
  // Build context for AI
  let vulnSummary = '';
  
  if (alertData.newCritical.length > 0) {
    vulnSummary += `NEW CRITICAL vulnerabilities found:\n`;
    for (const v of alertData.newCritical.slice(0, 5)) {
      vulnSummary += `- ${v.cve} (${v.technology} v${v.version}): ${v.description?.slice(0, 200)}...\n`;
    }
  }
  
  if (alertData.newHigh.length > 0) {
    vulnSummary += `\nNEW HIGH vulnerabilities found:\n`;
    for (const v of alertData.newHigh.slice(0, 5)) {
      vulnSummary += `- ${v.cve} (${v.technology} v${v.version}): ${v.description?.slice(0, 200)}...\n`;
    }
  }
  
  if (alertData.resolved.length > 0) {
    vulnSummary += `\nRESOLVED vulnerabilities:\n`;
    for (const v of alertData.resolved.slice(0, 3)) {
      vulnSummary += `- ${v.cve_id} (${v.technology}, was ${v.severity})\n`;
    }
  }
  
  const systemMessage = `[DUCKTAPE SECURITY at ${new Date().toLocaleTimeString()}] Vulnerability scan completed for ${project.name}!

URL: ${project.url}

${vulnSummary}

Please provide a brief, witty security analysis. What should the team prioritize? Any common patterns you notice?`;

  // Fetch message history from the channel
  let history = [];
  try {
    const fetchedMessages = await channel.messages.fetch({ limit: 50 });
    history = formatMessageHistory(Array.from(fetchedMessages.values()), client.user.id);
  } catch (fetchErr) {
    console.warn(`Could not fetch channel history for ${project.name}:`, fetchErr.message);
    history = [];
  }

  // Append DUCKTAPE SECURITY message to history
  history.push({
    role: 'user',
    content: systemMessage,
  });

  // Get AI response
  const aiReply = await getAIResponse(history);

  if (aiReply) {
    if (aiReply.length <= 2000) {
      await channel.send(aiReply);
    } else {
      const chunks = splitMessage(aiReply);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
    console.log(`✨ AI security explanation posted for ${project.name}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  initializeVulnScheduler,
  startVulnScheduler,
  stopVulnScheduler,
  triggerVulnCheck,
  scanGuildProjectsNow,
};

