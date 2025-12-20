import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import {
  createProject,
  getProjectsByGuild,
  getProjectsByChannel,
  deleteProject,
  setAlertChannel,
  getProjectById,
} from './db.js';
import { addProject as schedulerAddProject } from './scheduler.js';
import { generateStatusImage, generateTextStatus } from './statusGraph.js';

// Validate URL format
function isValidUrl(urlString) {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
}

// Handle /ducktape_add_project command - show modal
export async function handleAddProjectCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('ducktape_add_project_modal')
    .setTitle('Add Project to Monitor');

  const projectNameInput = new TextInputBuilder()
    .setCustomId('project_name')
    .setLabel('Project Name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g., My API')
    .setRequired(true);

  const urlInput = new TextInputBuilder()
    .setCustomId('project_url')
    .setLabel('URL to Monitor')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://example.com')
    .setRequired(true);

  const intervalInput = new TextInputBuilder()
    .setCustomId('check_interval')
    .setLabel('Check Interval (seconds)')
    .setStyle(TextInputStyle.Short)
    .setValue('300')
    .setRequired(true);

  const thresholdInput = new TextInputBuilder()
    .setCustomId('failure_threshold')
    .setLabel('Failure Threshold (consecutive)')
    .setStyle(TextInputStyle.Short)
    .setValue('3')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(projectNameInput),
    new ActionRowBuilder().addComponents(urlInput),
    new ActionRowBuilder().addComponents(intervalInput),
    new ActionRowBuilder().addComponents(thresholdInput)
  );

  await interaction.showModal(modal);
}

// Handle modal submission
export async function handleAddProjectModal(interaction) {
  const projectName = interaction.fields.getTextInputValue('project_name');
  const url = interaction.fields.getTextInputValue('project_url');
  const checkInterval = parseInt(interaction.fields.getTextInputValue('check_interval'));
  const failureThreshold = parseInt(interaction.fields.getTextInputValue('failure_threshold'));

  // Validate inputs
  if (!projectName || projectName.trim().length === 0) {
    await interaction.reply({ content: '❌ Project name cannot be empty', ephemeral: true });
    return;
  }

  if (!isValidUrl(url)) {
    await interaction.reply({ content: '❌ Invalid URL format', ephemeral: true });
    return;
  }

  if (isNaN(checkInterval) || checkInterval < 10) {
    await interaction.reply({ content: '❌ Check interval must be at least 10 seconds', ephemeral: true });
    return;
  }

  if (isNaN(failureThreshold) || failureThreshold < 1) {
    await interaction.reply({ content: '❌ Failure threshold must be at least 1', ephemeral: true });
    return;
  }

  try {
    // Check if project name already exists in this guild
    const existing = getProjectsByGuild(interaction.guildId);
    if (existing.some(p => p.name.toLowerCase() === projectName.toLowerCase())) {
      await interaction.reply({
        content: `❌ A project named "${projectName}" already exists in this server`,
        ephemeral: true,
      });
      return;
    }

    // Create project
    const projectId = createProject(
      interaction.guildId,
      interaction.channelId,
      projectName,
      url,
      failureThreshold,
      checkInterval
    );

    // Start monitoring this project
    schedulerAddProject(projectId);

    await interaction.reply({
      content: `✅ Project **${projectName}** added and monitoring started!\n🔗 URL: ${url}\n⏱️ Check interval: ${checkInterval}s\n⚠️ Alert threshold: ${failureThreshold} failures`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error creating project:', err);
    await interaction.reply({
      content: `❌ Error creating project: ${err.message}`,
      ephemeral: true,
    });
  }
}

// Handle /ducktape_here command
export async function handleDucktapeHereCommand(interaction) {
  try {
    const projectParam = interaction.options.getString('project');
    const projects = projectParam
      ? getProjectsByGuild(interaction.guildId).filter(
          p => p.name.toLowerCase().includes(projectParam.toLowerCase())
        )
      : getProjectsByChannel(interaction.guildId, interaction.channelId);

    if (projects.length === 0) {
      await interaction.reply({
        content: '❌ No projects found' + (projectParam ? ` matching "${projectParam}"` : ''),
        ephemeral: true,
      });
      return;
    }

    if (projects.length === 1) {
      // Single project - update directly
      setAlertChannel(projects[0].id, interaction.channelId);
      await interaction.reply({
        content: `✅ Alerts for **${projects[0].name}** will now be sent to this channel`,
        ephemeral: true,
      });
      return;
    }

    // Multiple projects - show selection menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ducktape_here_select')
      .setPlaceholder('Select project(s) to receive alerts')
      .setMinValues(1)
      .setMaxValues(Math.min(projects.length, 25));

    for (const project of projects) {
      selectMenu.addOptions({
        label: project.name,
        value: project.id.toString(),
        description: `URL: ${project.url.substring(0, 50)}`,
      });
    }

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
      content: 'Select which projects should send alerts to this channel:',
      components: [row],
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error handling ducktape_here:', err);
    await interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

// Handle select menu for /ducktape_here
export async function handleDucktapeHereSelect(interaction) {
  try {
    const selectedIds = interaction.values.map(v => parseInt(v));

    for (const projectId of selectedIds) {
      setAlertChannel(projectId, interaction.channelId);
    }

    await interaction.reply({
      content: `✅ Updated alerts for ${selectedIds.length} project(s) to this channel`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error handling ducktape_here select:', err);
    await interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

// Handle /ducktape_status command
export async function handleStatusCommand(interaction) {
  try {
    await interaction.deferReply();

    const projects = getProjectsByGuild(interaction.guildId);

    if (projects.length === 0) {
      await interaction.editReply({
        content: '📊 No projects configured yet. Use `/ducktape_add_project` to get started!',
      });
      return;
    }

    // Try to generate image, fallback to text
    let imageBuffer = null;
    try {
      imageBuffer = await generateStatusImage(projects);
    } catch (err) {
      console.warn('Failed to generate status image, using text fallback:', err);
    }

    if (imageBuffer) {
      await interaction.editReply({
        files: [
          {
            attachment: imageBuffer,
            name: 'status.png',
          },
        ],
      });
    } else {
      const textStatus = generateTextStatus(projects);
      await interaction.editReply({
        content: textStatus,
      });
    }
  } catch (err) {
    console.error('Error handling status command:', err);
    await interaction.editReply({
      content: `❌ Error generating status: ${err.message}`,
    });
  }
}

// Handle /ducktape_list_projects command
export async function handleListProjectsCommand(interaction) {
  try {
    const projects = getProjectsByGuild(interaction.guildId);

    if (projects.length === 0) {
      await interaction.reply({
        content: '📋 No projects configured in this server yet.',
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Monitored Projects')
      .setDescription(`Total: ${projects.length} project(s)`);

    for (const project of projects) {
      const channelMention = `<#${project.channel_id}>`;
      const alertChannel = project.alert_channel_id ? `<#${project.alert_channel_id}>` : 'Default (owned channel)';
      
      embed.addFields({
        name: project.name,
        value: `🔗 ${project.url}\n⏱️ Check: ${project.check_interval_sec}s | ⚠️ Threshold: ${project.failure_threshold}\n📍 Owned: ${channelMention}\n🔔 Alerts: ${alertChannel}`,
        inline: false,
      });
    }

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error listing projects:', err);
    await interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

// Handle /ducktape_remove_project command
export async function handleRemoveProjectCommand(interaction) {
  try {
    const projectName = interaction.options.getString('project');
    const projects = getProjectsByGuild(interaction.guildId);
    const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());

    if (!project) {
      await interaction.reply({
        content: `❌ Project "${projectName}" not found in this server`,
        ephemeral: true,
      });
      return;
    }

    deleteProject(project.id);

    await interaction.reply({
      content: `✅ Project **${project.name}** has been removed from monitoring`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error removing project:', err);
    await interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

