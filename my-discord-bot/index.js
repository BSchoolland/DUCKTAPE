import 'dotenv/config';

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { formatMessageHistory, getAIResponse } from './aiHandler.js';
import { splitMessage } from './messageUtils.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply("Pong");
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  await message.react('👀');

  try {
    const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
    
    // Format message history for AI
    const history = formatMessageHistory(Array.from(fetchedMessages.values()), client.user.id);
    
    // Get AI response
    const reply = await getAIResponse(history);
    
    if (reply) {
      // Split message if it exceeds Discord's 2000 character limit
      if (reply.length <= 2000) {
        await message.reply(reply);
      } else {
        const chunks = splitMessage(reply);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    }
  } catch (err) {
    console.error('Message handler error:', err);
    await message.reply("Sorry, something went wrong.");
  }
});

client.login(process.env.DISCORD_TOKEN);
