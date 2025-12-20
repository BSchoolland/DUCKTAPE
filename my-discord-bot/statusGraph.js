import { createCanvas } from 'canvas';
import { getUptimeForLast7Days, getUptimeStats } from './db.js';

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 400;
const PADDING = 60;
const GRAPH_AREA_HEIGHT = CHART_HEIGHT - 2 * PADDING;
const GRAPH_AREA_WIDTH = CHART_WIDTH - 2 * PADDING;

export async function generateStatusImage(projects) {
  try {
    const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

    // Title
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#000000';
    ctx.fillText('Uptime Status - Last 7 Days', PADDING, 40);

    // If no projects, show message
    if (!projects || projects.length === 0) {
      ctx.font = '16px Arial';
      ctx.fillStyle = '#999999';
      ctx.fillText('No projects configured', PADDING, CHART_HEIGHT / 2);
      return canvas.toBuffer('image/png');
    }

    // Draw project status bars
    let yOffset = PADDING + 40;
    const barHeight = 30;
    const spaceBetween = 50;

    for (const project of projects) {
      const stats = getUptimeStats(project.id);
      const uptimeData = getUptimeForLast7Days(project.id);

      // Project name and uptime percentage
      ctx.font = 'bold 14px Arial';
      ctx.fillStyle = '#000000';
      ctx.fillText(`${project.name}`, PADDING, yOffset + 15);

      if (stats) {
        ctx.font = '12px Arial';
        ctx.fillStyle = '#666666';
        ctx.fillText(`${stats.uptime_percentage}% uptime`, PADDING + 300, yOffset + 15);
      }

      // Draw uptime bar
      if (uptimeData && uptimeData.length > 0) {
        const barStartX = PADDING + 450;
        const barWidth = GRAPH_AREA_WIDTH - 150;
        const cellWidth = barWidth / 168; // 168 hours in 7 days

        // Draw timeline cells
        for (let i = 0; i < uptimeData.length; i++) {
          const check = uptimeData[i];
          const x = barStartX + (i * cellWidth);
          const y = yOffset;
          const w = cellWidth - 1; // Small gap between cells

          // Color based on status
          ctx.fillStyle = check.is_up ? '#4CAF50' : '#f44336'; // Green or red
          ctx.fillRect(x, y, w, barHeight - 5);

          // Border
          ctx.strokeStyle = '#cccccc';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, w, barHeight - 5);
        }

        // Draw status indicator
        const lastCheck = uptimeData[uptimeData.length - 1];
        const statusText = lastCheck.is_up ? 'UP' : 'DOWN';
        const statusColor = lastCheck.is_up ? '#4CAF50' : '#f44336';

        ctx.font = 'bold 12px Arial';
        ctx.fillStyle = statusColor;
        const textX = barStartX + barWidth + 20;
        ctx.fillText(statusText, textX, yOffset + 15);
      } else {
        ctx.font = '12px Arial';
        ctx.fillStyle = '#999999';
        ctx.fillText('No data', barStartX, yOffset + 15);
      }

      yOffset += spaceBetween;
    }

    // Draw legend
    const legendY = CHART_HEIGHT - 25;
    ctx.font = '12px Arial';
    ctx.fillStyle = '#999999';
    ctx.fillText('Green = Up | Red = Down | Shows last 7 days of checks', PADDING, legendY);

    return canvas.toBuffer('image/png');
  } catch (err) {
    console.error('Error generating status image:', err);
    return null;
  }
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

