import 'dotenv/config';

import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with pong')
    .toJSON(),
  
  new SlashCommandBuilder()
    .setName('ducktape_add_project')
    .setDescription('Add a new project to monitor for uptime')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ducktape_here')
    .setDescription('Set alert channel for a project to this channel')
    .addStringOption(option =>
      option
        .setName('project')
        .setDescription('Project name to send alerts for (leave empty for this channel\'s projects)')
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ducktape_status')
    .setDescription('View uptime status for all projects in this server')
    .addIntegerOption(option =>
      option
        .setName('days')
        .setDescription('Number of days to show (1-30, default: 7)')
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ducktape_list_projects')
    .setDescription('List all projects being monitored in this server')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ducktape_remove_project')
    .setDescription('Remove a project from monitoring')
    .addStringOption(option =>
      option
        .setName('project')
        .setDescription('Project name to remove')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ducktape_personality')
    .setDescription('Set a global personality trait for Ducktape')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  try {
    console.log('⏳ Registering slash commands...');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('Registered.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();

