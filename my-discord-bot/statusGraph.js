import { createCanvas } from 'canvas';
import { getUptimeForLast7Days, getUptimeStats } from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Design constants
const COLORS = {
  background: '#0d1117',
  cardBackground: '#161b22',
  border: '#30363d',
  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#6e7681',
  up: '#b1cd32',
  upBright: '#2ea043',
  down: '#da3633',
  downBright: '#f85149',
  partial: '#d29922',
  noData: '#21262d',
  accent: '#58a6ff',
};

const CHART_WIDTH = 1000;
const ROW_HEIGHT = 90;
const PADDING = 40;
const BAR_HEIGHT = 24;
const TIME_SLOTS = 84; // Fixed number of visual slots, each representing varying time periods
const SLOT_GAP = 2;

/**
 * Generate a status image for multiple projects
 * @param {Array} projects - Array of project objects with id, name, url
 * @param {number} days - Number of days to show (default: 7)
 * @returns {Object} { buffer: Buffer, filename: string } or null on error
 */
export async function generateStatusImage(projects, days = 7) {
  try {
    if (!projects || projects.length === 0) {
      return null;
    }

    const timeSlots = TIME_SLOTS; // Use fixed number of slots
    const now = Date.now();
    const msPerSlot = (days * 24 * 60 * 60 * 1000) / timeSlots;
    const startTime = now - (days * 24 * 60 * 60 * 1000);

    // Calculate dimensions
    const headerHeight = 80;
    const footerHeight = 80; // More space for date labels + legend
    const chartHeight = headerHeight + (projects.length * ROW_HEIGHT) + footerHeight;

    const canvas = createCanvas(CHART_WIDTH, chartHeight);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, CHART_WIDTH, chartHeight);

    // Gather project data and stats for filename generation
    const projectStats = [];

    // Draw header
    ctx.fillStyle = COLORS.textPrimary;
    ctx.font = 'bold 24px "Segoe UI", system-ui, -apple-system, sans-serif';
    ctx.fillText(`Uptime Status — Last ${days} Days`, PADDING, 48);

    // Draw each project row
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const yOffset = headerHeight + (i * ROW_HEIGHT);

      // Get uptime data
      const uptimeData = getUptimeForLast7Days(project.id);
      const stats = getUptimeStats(project.id);

      // Calculate uptime percentage for filename
      const uptimePercent = stats ? Math.round(parseFloat(stats.uptime_percentage)) : 0;
      projectStats.push({ name: project.name, uptime: uptimePercent });

      // Bucket the data into time slots
      const buckets = bucketUptimeData(uptimeData, startTime, now, timeSlots, msPerSlot);

      // Draw project card background
      ctx.fillStyle = COLORS.cardBackground;
      roundRect(ctx, PADDING - 8, yOffset, CHART_WIDTH - (PADDING * 2) + 16, ROW_HEIGHT - 8, 8);
      ctx.fill();

      // Project name
      ctx.fillStyle = COLORS.textPrimary;
      ctx.font = 'bold 14px "Segoe UI", system-ui, -apple-system, sans-serif';
      ctx.fillText(project.name, PADDING + 8, yOffset + 22);

      // Uptime percentage badge
      const uptimeText = stats ? `${stats.uptime_percentage}%` : 'N/A';
      const badgeColor = getBadgeColor(stats ? parseFloat(stats.uptime_percentage) : 0);
      
      ctx.fillStyle = badgeColor;
      const badgeWidth = ctx.measureText(uptimeText).width + 16;
      roundRect(ctx, CHART_WIDTH - PADDING - badgeWidth - 8, yOffset + 8, badgeWidth, 22, 4);
      ctx.fill();

      ctx.fillStyle = COLORS.textPrimary;
      ctx.font = 'bold 12px "Segoe UI Mono", "Consolas", monospace';
      ctx.fillText(uptimeText, CHART_WIDTH - PADDING - badgeWidth, yOffset + 23);

      // Draw status bar
      const barStartX = PADDING + 8;
      const barWidth = CHART_WIDTH - (PADDING * 2) - 16;
      const barY = yOffset + 36;
      const slotWidth = (barWidth - (timeSlots - 1) * SLOT_GAP) / timeSlots;

      for (let j = 0; j < timeSlots; j++) {
        const bucket = buckets[j];
        const x = barStartX + j * (slotWidth + SLOT_GAP);

        ctx.fillStyle = getSlotColor(bucket);
        roundRect(ctx, x, barY, slotWidth, BAR_HEIGHT, 3);
        ctx.fill();
      }

      // Current status indicator - measure with same font as project name
      const currentStatus = uptimeData.length > 0 ? uptimeData[uptimeData.length - 1].is_up : null;
      if (currentStatus !== null) {
        ctx.font = 'bold 14px "Segoe UI", system-ui, -apple-system, sans-serif';
        const projectNameWidth = ctx.measureText(project.name).width;
        
        const statusDot = currentStatus ? COLORS.upBright : COLORS.downBright;
        const statusText = currentStatus ? 'UP' : 'DOWN';
        
        const dotX = PADDING + 8 + projectNameWidth + 14;
        const textX = dotX + 12;
        
        ctx.fillStyle = statusDot;
        ctx.beginPath();
        ctx.arc(dotX, yOffset + 17, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = COLORS.textSecondary;
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(statusText, textX, yOffset + 21);
      }
    }

    // Draw time axis labels at the bottom
    const axisY = headerHeight + (projects.length * ROW_HEIGHT) + 24;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';

    // Show day markers
    const barStartX = PADDING + 8;
    const barWidth = CHART_WIDTH - (PADDING * 2) - 16;
    
    for (let d = 0; d <= days; d++) {
      const x = barStartX + (d / days) * barWidth;
      const date = new Date(startTime + (d * 24 * 60 * 60 * 1000));
      const label = d === days ? 'Now' : formatDateLabel(date);
      
      const textWidth = ctx.measureText(label).width;
      const labelX = d === days ? x - textWidth : (d === 0 ? x : x - textWidth / 2);
      
      ctx.fillText(label, labelX, axisY);
    }

    // Legend centered below the date labels
    const legendY = axisY + 28;
    const legendItems = [
      { color: COLORS.upBright, label: 'Up' },
      { color: COLORS.partial, label: 'Partial' },
      { color: COLORS.downBright, label: 'Down' },
      { color: COLORS.noData, label: 'No Data' },
    ];
    
    // Calculate total legend width for centering
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    const itemSpacing = 24; // space between items
    const iconWidth = 14;
    const iconTextGap = 6;
    
    let totalLegendWidth = 0;
    for (const item of legendItems) {
      totalLegendWidth += iconWidth + iconTextGap + ctx.measureText(item.label).width + itemSpacing;
    }
    totalLegendWidth -= itemSpacing; // remove trailing space
    
    let legendX = (CHART_WIDTH - totalLegendWidth) / 2;
    
    for (const item of legendItems) {
      drawLegendItem(ctx, legendX, legendY, item.color, item.label);
      const labelWidth = ctx.measureText(item.label).width;
      legendX += iconWidth + iconTextGap + labelWidth + itemSpacing;
    }

    // Generate content-based filename
    const filename = generateFilename(projectStats);

    // Return buffer and filename
    const buffer = canvas.toBuffer('image/png');
    return { buffer, filename };

  } catch (err) {
    console.error('Error generating status image:', err);
    return null;
  }
}

/**
 * Bucket uptime data into time slots
 */
function bucketUptimeData(uptimeData, startTime, endTime, numSlots, msPerSlot) {
  const buckets = new Array(numSlots).fill(null).map(() => ({
    checks: 0,
    upCount: 0,
  }));

  for (const check of uptimeData) {
    // SQLite CURRENT_TIMESTAMP stores in UTC, so append 'Z' to parse correctly
    const checkTime = new Date(check.checked_at + 'Z').getTime();
    if (checkTime < startTime || checkTime > endTime) continue;

    const slotIndex = Math.floor((checkTime - startTime) / msPerSlot);
    if (slotIndex >= 0 && slotIndex < numSlots) {
      buckets[slotIndex].checks++;
      if (check.is_up) {
        buckets[slotIndex].upCount++;
      }
    }
  }

  return buckets;
}

/**
 * Get color for a time slot based on uptime ratio
 */
function getSlotColor(bucket) {
  if (bucket.checks === 0) {
    return COLORS.noData;
  }

  const ratio = bucket.upCount / bucket.checks;

  if (ratio >= 1) {
    return COLORS.upBright;
  } else if (ratio >= 0.8) {
    return COLORS.up;
  } else if (ratio >= 0.5) {
    return COLORS.partial;
  } else if (ratio > 0) {
    return COLORS.down;
  } else {
    return COLORS.downBright;
  }
}

/**
 * Get badge color based on uptime percentage
 */
function getBadgeColor(percentage) {
  if (percentage >= 99.9) return COLORS.upBright;
  if (percentage >= 99) return COLORS.up;
  if (percentage >= 95) return COLORS.partial;
  return COLORS.down;
}

/**
 * Format date for axis label
 */
function formatDateLabel(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Draw a rounded rectangle
 */
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Draw legend item
 */
function drawLegendItem(ctx, x, y, color, label) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y - 10, 12, 12, 3);
  ctx.fill();

  ctx.fillStyle = COLORS.textSecondary;
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(label, x + 18, y);
}

/**
 * Generate content-based filename
 * Format: uptime-projectA-99-projectB-97-...timestamp.png
 */
function generateFilename(projectStats) {
  const parts = ['uptime'];
  
  for (const stat of projectStats) {
    // Sanitize project name: lowercase, replace non-alphanumeric with dash
    const safeName = stat.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 20);
    
    parts.push(`${safeName}-${stat.uptime}`);
  }

  // Add short timestamp for uniqueness
  const timestamp = Date.now().toString(36);
  parts.push(timestamp);

  return parts.join('-') + '.png';
}

/**
 * Save the image to disk and return the path
 */
export async function saveStatusImage(projects, days = 7) {
  const result = await generateStatusImage(projects, days);
  if (!result) return null;

  const { buffer, filename } = result;
  const filepath = path.join(__dirname, filename);
  
  fs.writeFileSync(filepath, buffer);
  return { filepath, filename };
}

// Fallback text-based status if image generation fails
export function generateTextStatus(projects) {
  if (!projects || projects.length === 0) {
    return '📊 No projects configured yet.';
  }

  let text = '📊 **Uptime Status - Last 7 Days**\n\n';

  for (const project of projects) {
    const stats = getUptimeStats(project.id);
    const uptimeData = getUptimeForLast7Days(project.id);

    text += `**${project.name}**\n`;
    text += `URL: ${project.url}\n`;

    if (stats) {
      text += `Uptime: ${stats.uptime_percentage}% (${stats.successful_checks}/${stats.total_checks} checks)\n`;
      if (stats.avg_response_time) {
        text += `Avg Response Time: ${stats.avg_response_time}ms\n`;
      }
    }

    if (uptimeData && uptimeData.length > 0) {
      const lastCheck = uptimeData[uptimeData.length - 1];
      const statusEmoji = lastCheck.is_up ? '🟢' : '🔴';
      text += `Current Status: ${statusEmoji} ${lastCheck.is_up ? 'UP' : 'DOWN'}\n`;
    }

    text += '\n';
  }

  return text;
}
