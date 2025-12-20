import 'dotenv/config';

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { formatMessageHistory, getAIResponse } from './aiHandler.js';
import { splitMessage } from './messageUtils.js';
import { initializeDatabase } from './db.js';
import { initializeScheduler, startScheduler } from './scheduler.js';
import {
  handleAddProjectCommand,
  handleAddProjectModal,
  handleDucktapeHereCommand,
  handleDucktapeHereSelect,
  handleStatusCommand,
  handleListProjectsCommand,
  handleRemoveProjectCommand,
} from './commands.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  // Initialize database and scheduler
  initializeDatabase();
  console.log('🗄️ Database initialized');

  initializeScheduler(c);
  startScheduler();
  console.log('🔄 Scheduler started');
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    try {
      switch (interaction.commandName) {
        case 'ping':
          await interaction.reply('Pong');
          break;
        case 'ducktape_add_project':
          await handleAddProjectCommand(interaction);
          break;
        case 'ducktape_here':
          await handleDucktapeHereCommand(interaction);
          break;
        case 'ducktape_status':
          await handleStatusCommand(interaction);
          break;
        case 'ducktape_list_projects':
          await handleListProjectsCommand(interaction);
          break;
        case 'ducktape_remove_project':
          await handleRemoveProjectCommand(interaction);
          break;
        default:
          await interaction.reply({ content: 'Unknown command', ephemeral: true });
      }
    } catch (err) {
      console.error('Command error:', err);
      const reply = { content: 'An error occurred while processing the command', ephemeral: true };
      if (interaction.replied) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
    return;
  }

  // Handle modal submissions
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId === 'ducktape_add_project_modal') {
        await handleAddProjectModal(interaction);
      }
    } catch (err) {
      console.error('Modal error:', err);
      const reply = { content: 'An error occurred while processing the form', ephemeral: true };
      if (interaction.replied) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
    return;
  }

  // Handle select menus
  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'ducktape_here_select') {
        await handleDucktapeHereSelect(interaction);
      }
    } catch (err) {
      console.error('Select menu error:', err);
      const reply = { content: 'An error occurred', ephemeral: true };
      if (interaction.replied) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
    return;
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
