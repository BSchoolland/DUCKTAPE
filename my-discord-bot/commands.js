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
  setUserPersonalityTrait,
  ignoreCVEs,
} from './db.js';
import { addProject as schedulerAddProject } from './scheduler.js';
import { generateStatusImage, generateTextStatus } from './statusGraph.js';
import { scanGuildProjectsNow } from './vulnScheduler.js';

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
      ephemeral: false,
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
// Sets the alert channel for **all** projects in this guild to the current channel
export async function handleDucktapeHereCommand(interaction) {
  try {
    const projects = getProjectsByGuild(interaction.guildId);

    if (projects.length === 0) {
      await interaction.reply({
        content: '❌ No projects configured in this server yet.',
        ephemeral: true,
      });
      return;
    }

    for (const project of projects) {
      setAlertChannel(project.id, interaction.channelId);
    }

    await interaction.reply({
      content: `✅ Alerts for all ${projects.length} project(s) in this server will now be sent to this channel`,
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

// Handle select menu for ignoring vulnerabilities for a project
export async function handleIgnoreCVEsSelect(interaction) {
  try {
    const [prefix, projectIdStr] = interaction.customId.split(':');
    const projectId = parseInt(projectIdStr, 10);

    if (!projectId || Number.isNaN(projectId)) {
      await interaction.reply({
        content: '❌ Could not determine project for this vulnerability selection.',
        ephemeral: true,
      });
      return;
    }

    const cveIds = interaction.values || [];

    if (cveIds.length === 0) {
      await interaction.reply({
        content: 'No vulnerabilities were selected to ignore.',
        ephemeral: true,
      });
      return;
    }

    ignoreCVEs(projectId, cveIds, interaction.user.id);

    await interaction.reply({
      content: `✅ Marked ${cveIds.length} vulnerability(ies) as ignored for this project.\nThey will no longer trigger alerts in future scans.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Error handling ignore CVEs select:', err);
    const reply = {
      content: `❌ Error ignoring vulnerabilities: ${err.message}`,
      ephemeral: true,
    };

    if (interaction.replied) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

// Handle /ducktape_status command
export async function handleStatusCommand(interaction) {
  try {
    await interaction.deferReply();

    const projects = getProjectsByGuild(interaction.guildId);
    
    // Get days parameter (default to 7)
    const days = interaction.options.getInteger('days') || 7;

    if (projects.length === 0) {
      await interaction.editReply({
        content: '📊 No projects configured yet. Use `/ducktape_add_project` to get started!',
      });
      return;
    }

    // Try to generate image, fallback to text
    let imageResult = null;
    try {
      imageResult = await generateStatusImage(projects, days);
    } catch (err) {
      console.warn('Failed to generate status image, using text fallback:', err);
    }

    if (imageResult) {
      await interaction.editReply({
        files: [
          {
            attachment: imageResult.buffer,
            name: imageResult.filename,
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

// Handle /ducktape_personality command - show modal
export async function handlePersonalityCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('ducktape_personality_modal')
    .setTitle('Set Ducktape Personality');

  const traitInput = new TextInputBuilder()
    .setCustomId('personality_trait')
    .setLabel('Your Personality Trait')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Max 30 words (this will replace your previous trait)')
    .setMaxLength(250)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(traitInput));

  await interaction.showModal(modal);
}

// Handle personality modal submission
export async function handlePersonalityModal(interaction) {
  const trait = interaction.fields.getTextInputValue('personality_trait');

  // Validate that trait is not empty after trimming
  if (!trait || trait.trim().length === 0) {
    await interaction.reply({
      content: '❌ Personality trait cannot be empty',
      ephemeral: true,
    });
    return;
  }

  // Validate word count (max 30 words)
  const wordCount = trait.trim().split(/\s+/).length;
  if (wordCount > 30) {
    await interaction.reply({
      content: `❌ Personality trait must be 30 words or less (you provided ${wordCount} words)`,
      ephemeral: true,
    });
    return;
  }

  try {
    setUserPersonalityTrait(interaction.user.id, interaction.user.username, trait.trim());

    await interaction.reply({
      content: `✨ **${interaction.user.username}** set a personality trait:\n> "${trait.trim()}"\n\n(This will replace any previous trait they had set, but keep traits from other users)`,
      ephemeral: false,
    });
  } catch (err) {
    console.error('Error saving personality trait:', err);
    await interaction.reply({
      content: `❌ Error saving personality trait: ${err.message}`,
      ephemeral: true,
    });
  }
}

// Handle /ducktape_scan_vulns command
export async function handleScanVulnsCommand(interaction) {
  try {
    const projects = getProjectsByGuild(interaction.guildId);

    if (projects.length === 0) {
      await interaction.reply({
        content: '❌ No projects configured in this server yet. Use `/ducktape_add_project` to add one first.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `🔒 Starting vulnerability scan for ${projects.length} project(s)...\nThis may take a few minutes. Alerts will be posted if vulnerabilities are found.`,
      ephemeral: false,
    });

    // Run the scan in the background (don't await), pass channel for completion message
    scanGuildProjectsNow(interaction.guildId, interaction.channel)
      .then(result => {
        console.log(`✅ Vulnerability scan complete for guild ${interaction.guildId}: ${result.scanned} projects, ${result.totalCritical} critical, ${result.totalHigh} high`);
      })
      .catch(err => {
        console.error(`Vulnerability scan failed for guild ${interaction.guildId}:`, err);
      });

  } catch (err) {
    console.error('Error handling scan vulns command:', err);
    await interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

