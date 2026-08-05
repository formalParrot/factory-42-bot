import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import config from './config.js';
import { snapshotAll } from './services.js';
import {
  buildControlRows,
  buildStatusEmbed,
  buildSystemEmbeds,
  setDashboardMessages,
  updateDashboard,
} from './dashboard.js';
import { restartService, startService, stopService } from './actions.js';
import { fetchSystemStats, panelConfigured } from './panel.js';
import { serviceState } from './state.js';

const POST_COLOR = 0x5865f2;
const PENDING_TTL_MS = 15 * 60_000;

// /modpack attachments awaiting their modal submit, keyed by interaction id.
const pendingModpacks = new Map();

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return config.adminRoleId ? member.roles.cache.has(config.adminRoleId) : false;
}

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isModalSubmit()) return handleModal(interaction);
}

async function handleCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'status') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshots = await snapshotAll();
    const embeds = [buildStatusEmbed(snapshots)];
    if (panelConfigured()) {
      try {
        embeds.push(...buildSystemEmbeds(await fetchSystemStats()));
      } catch {
        // Panel unreachable; show service status only.
      }
    }
    return interaction.editReply({ embeds });
  }

  if (!isAdmin(interaction.member)) {
    return interaction.reply({
      content: 'You need the admin role to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (commandName === 'dashboard') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshots = await snapshotAll();
    let systemMessage = null;
    if (panelConfigured()) {
      try {
        systemMessage = await interaction.channel.send({
          embeds: buildSystemEmbeds(await fetchSystemStats()),
        });
      } catch {
        // Panel unreachable at setup; the live loop will populate it later.
        systemMessage = await interaction.channel.send({
          embeds: [new EmbedBuilder().setTitle('System').setDescription('Waiting for panel...')],
        });
      }
    }
    const dashboardMessage = await interaction.channel.send({
      embeds: [buildStatusEmbed(snapshots)],
      components: buildControlRows(snapshots),
    });
    await setDashboardMessages(interaction.client, dashboardMessage, systemMessage);
    return interaction.editReply('Dashboard created.');
  }

  if (commandName === 'announce') {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const modal = new ModalBuilder()
      .setCustomId(`announce:${channel.id}`)
      .setTitle('Announcement')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(256),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('message')
            .setLabel('Message')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000),
        ),
      );
    return interaction.showModal(modal);
  }

  if (commandName === 'modpack') {
    const file = interaction.options.getAttachment('file', true);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.mrpack') && !lower.endsWith('.zip')) {
      return interaction.reply({
        content: 'The file must be a .mrpack or .zip archive.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const nonce = interaction.id;
    pendingModpacks.set(nonce, { url: file.url, name: file.name, channelId: channel.id });
    setTimeout(() => pendingModpacks.delete(nonce), PENDING_TTL_MS).unref?.();
    const modal = new ModalBuilder()
      .setCustomId(`modpack:${nonce}`)
      .setTitle('Modpack update')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('version')
            .setLabel('Version')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('changelog')
            .setLabel('Changelog')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000),
        ),
      );
    return interaction.showModal(modal);
  }
}

async function handleButton(interaction) {
  const [ns, action, arg] = interaction.customId.split(':');

  if (ns === 'dash') {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({
        content: 'You need the admin role to use these controls.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const index = Number(arg);
    const service = config.services[index];
    if (!service) return;

    if (action === 'start') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await startService(index);
      await updateDashboard(interaction.client);
      return interaction.editReply(
        result === 'already-running'
          ? `${service.name} is already running.`
          : `${service.name} is starting.`,
      );
    }

    if (action === 'stop' || action === 'restart') {
      const label = action === 'stop' ? 'Stop' : 'Restart';
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm:${action}:${index}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('confirm:cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({
        content: `${label} ${service.name}? Online players will be disconnected.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (ns === 'confirm') {
    if (action === 'cancel') {
      return interaction.update({ content: 'Cancelled.', components: [] });
    }
    if (!isAdmin(interaction.member)) return;
    const index = Number(arg);
    const service = config.services[index];
    if (!service) return;
    if (serviceState.has(index)) {
      return interaction.update({
        content: `${service.name} is already being ${serviceState.get(index) === 'stopping' ? 'stopped' : 'started'}.`,
        components: [],
      });
    }

    if (action === 'stop') {
      await interaction.update({
        content: `Stopping ${service.name}. This can take up to 60 seconds.`,
        components: [],
      });
      const done = stopService(index);
      updateDashboard(interaction.client);
      const result = await done;
      await updateDashboard(interaction.client);
      const text =
        result === 'killed'
          ? `${service.name} did not stop within 60 seconds and was force-killed.`
          : result === 'already-stopped'
            ? `${service.name} is not running.`
            : `${service.name} stopped.`;
      return interaction.editReply({ content: text });
    }

    if (action === 'restart') {
      await interaction.update({
        content: `Restarting ${service.name}. This can take up to 60 seconds.`,
        components: [],
      });
      const done = restartService(index);
      updateDashboard(interaction.client);
      const result = await done;
      await updateDashboard(interaction.client);
      const text =
        result === 'killed-restarted'
          ? `${service.name} did not stop gracefully and was force-killed, then started again.`
          : `${service.name} is restarting.`;
      return interaction.editReply({ content: text });
    }
  }
}

async function handleModal(interaction) {
  const [ns, arg] = interaction.customId.split(':');
  if (!isAdmin(interaction.member)) {
    return interaction.reply({
      content: 'You need the admin role to use this.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (ns === 'announce') {
    const channel = await interaction.client.channels.fetch(arg);
    const embed = new EmbedBuilder()
      .setTitle(interaction.fields.getTextInputValue('title'))
      .setDescription(interaction.fields.getTextInputValue('message'))
      .setColor(POST_COLOR)
      .setTimestamp(new Date());
    await channel.send({ embeds: [embed] });
    return interaction.reply({
      content: `Announcement posted in <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (ns === 'modpack') {
    const pending = pendingModpacks.get(arg);
    if (!pending) {
      return interaction.reply({
        content: 'This modpack form expired. Run /modpack again.',
        flags: MessageFlags.Ephemeral,
      });
    }
    pendingModpacks.delete(arg);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const version = interaction.fields.getTextInputValue('version');
    const changelog = interaction.fields.getTextInputValue('changelog');
    const response = await fetch(pending.url);
    if (!response.ok) {
      return interaction.editReply('Could not download the attached file from Discord.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const embed = new EmbedBuilder()
      .setTitle(`Modpack update ${version}`)
      .setDescription(changelog)
      .setColor(POST_COLOR)
      .setTimestamp(new Date());
    const channel = await interaction.client.channels.fetch(pending.channelId);
    await channel.send({
      embeds: [embed],
      files: [new AttachmentBuilder(buffer, { name: pending.name })],
    });
    return interaction.editReply(`Modpack update posted in <#${channel.id}>.`);
  }
}
