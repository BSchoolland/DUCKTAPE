import { OpenRouter } from '@openrouter/sdk';
import { getAllPersonalityTraits } from './db.js';

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
    
    const systemPrompt = baseSystemPrompt + traitsSection;
    
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

