import { OpenRouter } from '@openrouter/sdk';
import { getAllPersonalityTraits, getAllActiveProjects, getUptimeForLast3Hours, getProjectStatus } from './db.js';

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * Formats message history for the AI model
 * @param {Array} fetchedMessages - Messages to include in history
 * @param {string} clientUserId - The bot's user ID
 * @returns {Array} Formatted message history
 */
export function formatMessageHistory(fetchedMessages, clientUserId) {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentMessages = Array.from(fetchedMessages)
    .filter(m => m.createdTimestamp > oneDayAgo);

  return recentMessages
    .reverse()
    .filter(m => !m.author.bot || m.author.id === clientUserId)
    .slice(0, 100)
    .map(m => {
      const role = m.author.id === clientUserId ? "assistant" : "user";
      let content = m.content;
      
      // Handle attachments
      if (!content && m.attachments.size > 0) {
        const filenames = Array.from(m.attachments.values())
          .map(att => att.name || "unknown")
          .join(", ");
        content = `uploaded ${filenames}`;
      }
      
      // Add timestamp and author info for user messages
      if (role === "user") {
        const timestamp = new Date(m.createdTimestamp).toLocaleTimeString();
        const author = m.author.username;
        content = `[${author} at ${timestamp}] ${content}`;
      }
      
      return { role, content };
    });
}

/**
 * Bucket uptime checks into 15-minute intervals
 * @param {Array} uptimeChecks - Raw uptime check records
 * @param {number} hoursAgo - How many hours back to analyze (default 3)
 * @returns {Array} Array of 12 bucket states: 'UP', 'DOWN', 'PARTIAL', or 'NO_DATA'
 */
function bucketUptimeInto15MinIntervals(uptimeChecks, hoursAgo = 3) {
  const numBuckets = (hoursAgo * 60) / 15; // 12 buckets for 3 hours
  const msPerBucket = 15 * 60 * 1000; // 15 minutes in milliseconds
  const now = Date.now();
  const startTime = now - (hoursAgo * 60 * 60 * 1000);

  // Initialize buckets
  const buckets = Array(numBuckets).fill(null).map(() => ({
    checks: 0,
    upCount: 0,
  }));

  // Fill buckets with check data
  for (const check of uptimeChecks) {
    // SQLite CURRENT_TIMESTAMP stores in UTC, append 'Z' to parse correctly
    const checkTime = new Date(check.checked_at + 'Z').getTime();
    if (checkTime < startTime || checkTime > now) continue;

    const bucketIndex = Math.floor((checkTime - startTime) / msPerBucket);
    if (bucketIndex >= 0 && bucketIndex < numBuckets) {
      buckets[bucketIndex].checks++;
      if (check.is_up) {
        buckets[bucketIndex].upCount++;
      }
    }
  }

  // Convert buckets to state strings
  return buckets.map(bucket => {
    if (bucket.checks === 0) return 'NO_DATA';
    const ratio = bucket.upCount / bucket.checks;
    if (ratio >= 1) return 'UP';
    if (ratio >= 0.5) return 'PARTIAL';
    return 'DOWN';
  });
}

/**
 * Generate uptime summary for all projects (last 3 hours, 15-min intervals)
 * @returns {string} Formatted uptime context string for system prompt
 */
function generateUptimeContext() {
  const projects = getAllActiveProjects();
  
  if (projects.length === 0) {
    return 'No projects are currently being monitored.';
  }

  let context = 'Current uptime status for all monitored projects:\n';
  
  for (const project of projects) {
    const status = getProjectStatus(project.id);
    const recentChecks = getUptimeForLast3Hours(project.id);
    const buckets = bucketUptimeInto15MinIntervals(recentChecks, 3);
    
    // Current status
    const currentStatus = status && status.is_up ? '🟢 UP' : '🔴 DOWN';
    
    // Compact timeline representation (each char = 15 min, last 3 hours = 12 slots)
    const timeline = buckets.map(state => {
      if (state === 'UP') return '✓';
      if (state === 'DOWN') return '✗';
      if (state === 'PARTIAL') return '~';
      return '·';
    }).join('');
    
    context += `  • ${project.name} (${currentStatus}): [${timeline}] (oldest→newest, 15min each)\n`;
  }
  
  context += 'Legend: ✓=UP, ✗=DOWN, ~=PARTIAL, ·=NO_DATA';
  
  return context;
}

/**
 * Gets a response from the OpenRouter AI model
 * @param {Array} history - Message history to send to AI
 * @returns {Promise<string|null>} The AI response content or null if failed
 */
export async function getAIResponse(history) {
  try {
    const baseSystemPrompt = "You are a AI discord bot named Ducktape designed to notify the user when projects they are monitoring have issues. Keep all responses concise and under 200 words.  You're not all serious though.  Personality traits: ";
    
    // Fetch all user-defined personality traits
    const personalityTraits = getAllPersonalityTraits();
    const traitsSection = personalityTraits.length > 0 
      ? personalityTraits.join("; ") 
      : "None set yet - be naturally helpful and friendly.";
    
    // Generate uptime context for all projects
    const uptimeContext = generateUptimeContext();
    
    const systemPrompt = baseSystemPrompt + traitsSection + "\n\n" + uptimeContext;
    
    const response = await openrouter.chat.send({
      model: "x-ai/grok-4.1-fast",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
    });
    
    return response?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('AI Response Error:', err);
    throw err;
  }
}

