import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import config from './config.js';
import { snapshotAll } from './services.js';
import { serviceState } from './state.js';
import {
  fetchSystemStats,
  formatSystemFields,
  panelConfigured,
  usageMetrics,
} from './panel.js';
import { fetchPlayerList } from './rcon.js';

const COLOR_ONLINE = 0x57f287;
const COLOR_OFFLINE = 0xed4245;
const COLOR_PARTIAL = 0xfee75c;
// System and control embeds use a fixed colour so they don't flicker between
// states; only the public status embed tracks online/offline colour.
const COLOR_SYSTEM = 0x5865f2;
const COLOR_CONTROL = 0x5865f2;

// Bar-graph segments. Coloured emoji squares escalate with usage
// (white -> yellow -> orange -> red). Emoji render inline with no code block,
// so editing the message does not trigger the code-block reflow that flickers.
const BAR_SEGMENTS = 10;
const SQUARE_EMPTY = '⬛';

function usageSquare(percent) {
  if (percent >= 90) return '🟥';
  if (percent >= 85) return '🟧';
  if (percent >= 75) return '🟨';
  return '⬜';
}

function usageBar(percent) {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((percent / 100) * BAR_SEGMENTS)));
  return usageSquare(percent).repeat(filled) + SQUARE_EMPTY.repeat(BAR_SEGMENTS - filled);
}

const DATA_DIR = new URL('../data/', import.meta.url);
const DATA_FILE = new URL('../data/dashboard.json', import.meta.url);
export const DASHBOARD_INTERVAL_MS = 30_000;

// { channelId, dashboardMessageId, controlChannelId, controlMessageId }
let location = null;
const cache = { dashboard: null, control: null };

function loadLocation() {
  try {
    location = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    location = null;
  }
}

function persistLocation() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(location));
}

export function getLocation() {
  return location;
}

export async function setDashboardMessages(client, dashboardMessage, controlMessage) {
  location = {
    channelId: dashboardMessage.channelId,
    dashboardMessageId: dashboardMessage.id,
    controlChannelId: controlMessage?.channelId ?? null,
    controlMessageId: controlMessage?.id ?? null,
  };
  cache.dashboard = dashboardMessage;
  cache.control = controlMessage ?? null;
  persistLocation();
}

export function buildStatusEmbed(snapshots) {
  const embed = new EmbedBuilder().setTitle('Server Dashboard').setTimestamp(new Date());
  embed.addFields(
    config.services.map((service, i) => {
      const snap = snapshots[i];
      const state = serviceState.get(i);
      let statusText;
      if (state === 'starting') statusText = 'Starting';
      else if (state === 'stopping') statusText = 'Stopping';
      else statusText = snap.running ? 'Online' : 'Offline';
      const lines = [`Status: ${statusText}`];
      if (snap.running && service.ping) {
        lines.push(
          snap.ping
            ? `Players: ${snap.ping.online}/${snap.ping.max}`
            : 'Players: n/a',
        );
      }
      return { name: service.name, value: lines.join('\n'), inline: true };
    }),
  );
  const online = snapshots.filter((s) => s.running).length;
  embed.setColor(
    online === snapshots.length ? COLOR_ONLINE : online === 0 ? COLOR_OFFLINE : COLOR_PARTIAL,
  );
  return embed;
}

export function buildSystemEmbed(stats) {
  const f = formatSystemFields(stats);
  const fields = [{ name: 'Uptime', value: f.uptime, inline: false }];
  for (const metric of usageMetrics(stats)) {
    const percent = Math.round(metric.percent);
    const detail = metric.detail ? `\n${metric.detail}` : '';
    fields.push({
      name: metric.label,
      value: `${usageBar(metric.percent)} ${percent}%${detail}`,
      inline: false,
    });
  }
  return new EmbedBuilder()
    .setTitle('System')
    .setColor(COLOR_SYSTEM)
    .addFields(fields)
    .setTimestamp(new Date());
}

// Header for the mod-only control message that carries the start/stop/restart rows.
export function buildControlEmbed() {
  return new EmbedBuilder()
    .setTitle('Server Controls')
    .setColor(COLOR_CONTROL)
    .setDescription('Start, stop, or restart a server.');
}

export function buildControlRows(snapshots) {
  return config.services.map((service, i) => {
    const running = snapshots[i].running;
    const busy = serviceState.has(i);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dash:label:${i}`)
        .setLabel(service.name)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`dash:start:${i}`)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(running || busy),
      new ButtonBuilder()
        .setCustomId(`dash:stop:${i}`)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!running || busy),
      new ButtonBuilder()
        .setCustomId(`dash:restart:${i}`)
        .setLabel('Restart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!running || busy),
    );
  });
}

export function buildPlayerListEmbed(players) {
  const embed = new EmbedBuilder()
    .setTitle('Player List')
    .setColor(COLOR_SYSTEM)
    .setTimestamp(new Date());
  embed.setDescription(players.length ? players.join('\n') : 'No players online.');
  return embed;
}

// 10008 Unknown Message / 10003 Unknown Channel: the message was deleted.
function isDeleted(err) {
  return err?.code === 10008 || err?.code === 10003;
}

async function resolveMessage(client, which, channelId, messageId) {
  if (cache[which]) return cache[which];
  const channel = await client.channels.fetch(channelId);
  cache[which] = await channel.messages.fetch(messageId);
  return cache[which];
}

export async function updateDashboard(client) {
  if (!location?.dashboardMessageId && !location?.controlMessageId) return;
  const snapshots = await snapshotAll();

  if (location?.dashboardMessageId) {
    const embeds = [buildStatusEmbed(snapshots)];
    if (panelConfigured()) {
      try {
        embeds.push(buildSystemEmbed(await fetchSystemStats()));
      } catch {
        // Panel unreachable; omit system embed.
      }
    }
    try {
      const players = await fetchPlayerList();
      embeds.push(buildPlayerListEmbed(players));
    } catch (err) {
      console.error('Player list fetch failed:', err.message ?? err);
      embeds.push(buildPlayerListEmbed([]));
    }
    try {
      const message = await resolveMessage(
        client,
        'dashboard',
        location.channelId,
        location.dashboardMessageId,
      );
      await message.edit({ embeds });
    } catch (err) {
      cache.dashboard = null;
      if (isDeleted(err)) {
        location.dashboardMessageId = null;
        persistLocation();
        console.warn('Dashboard message was deleted; run /dashboard setup again.');
      } else {
        console.error('Dashboard update failed:', err);
      }
    }
  }

  if (location?.controlMessageId) {
    try {
      const message = await resolveMessage(
        client,
        'control',
        location.controlChannelId,
        location.controlMessageId,
      );
      await message.edit({ components: buildControlRows(snapshots) });
    } catch (err) {
      cache.control = null;
      if (isDeleted(err)) {
        location.controlMessageId = null;
        persistLocation();
        console.warn('Control message was deleted; run /dashboard setup again.');
      } else {
        console.error('Control update failed:', err);
      }
    }
  }
}

export function startUpdater(client) {
  loadLocation();
  updateDashboard(client);
  setInterval(() => updateDashboard(client), DASHBOARD_INTERVAL_MS);
}
