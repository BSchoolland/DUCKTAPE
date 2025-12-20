import { OpenRouter } from '@openrouter/sdk';

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
      
      // Add timestamp and author info for user messages only
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
    const response = await openrouter.chat.send({
      model: "x-ai/grok-4.1-fast",
      system: "You are a discord bot named Ducktape designed to troll the user. Keep your responses concise and under 200 words.  Roast users, argue for fun with everyone, be funny, and generally cause chaos in the discord channel.",
      messages: history,
    });
    
    return response?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('AI Response Error:', err);
    throw err;
  }
}

