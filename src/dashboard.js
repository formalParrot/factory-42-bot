import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import config from './config.js';
import { snapshotAll } from './services.js';
import { serviceState } from './state.js';
import {
  fetchSystemStats,
  formatSystemFields,
  panelConfigured,
  refreshMs,
  usageMetrics,
} from './panel.js';

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

// { channelId, dashboardMessageId, systemMessageId, controlChannelId, controlMessageId }
let location = null;
// Cached Message objects so the 1s system loop is a single PATCH, not a fetch chain.
const cache = { dashboard: null, system: null, control: null };
// Signature of the last System embed we sent, to skip no-op edits.
let lastSystemSig = null;

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

async function deleteIfPresent(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const old = await channel.messages.fetch(messageId);
    await old.delete();
  } catch {
    // Already gone.
  }
}

export async function setDashboardMessages(client, dashboardMessage, systemMessage, controlMessage) {
  if (location) {
    await deleteIfPresent(client, location.channelId, location.dashboardMessageId);
    await deleteIfPresent(client, location.channelId, location.systemMessageId);
    await deleteIfPresent(client, location.controlChannelId, location.controlMessageId);
  }
  location = {
    channelId: dashboardMessage.channelId,
    dashboardMessageId: dashboardMessage.id,
    systemMessageId: systemMessage?.id ?? null,
    controlChannelId: controlMessage?.channelId ?? null,
    controlMessageId: controlMessage?.id ?? null,
  };
  cache.dashboard = dashboardMessage;
  cache.system = systemMessage ?? null;
  cache.control = controlMessage ?? null;
  lastSystemSig = null; // force a first render onto the new message
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

// Kept as a single-element array so callers can spread it into a message's embeds.
export function buildSystemEmbeds(stats) {
  return [buildSystemEmbed(stats)];
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
    try {
      const message = await resolveMessage(
        client,
        'dashboard',
        location.channelId,
        location.dashboardMessageId,
      );
      await message.edit({ embeds: [buildStatusEmbed(snapshots)] });
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

async function updateSystem(client) {
  if (!location?.systemMessageId || !panelConfigured()) return;
  try {
    const stats = await fetchSystemStats();
    const embeds = buildSystemEmbeds(stats);
    // Only edit when something visible changed. The timestamp is excluded, so a
    // steady reading doesn't re-edit every tick and re-flicker the code block.
    const sig = JSON.stringify(embeds.map((e) => [e.data.color, e.data.fields]));
    if (sig === lastSystemSig) return;
    const message = await resolveMessage(
      client,
      'system',
      location.channelId,
      location.systemMessageId,
    );
    await message.edit({ embeds });
    lastSystemSig = sig;
  } catch (err) {
    if (isDeleted(err)) {
      cache.system = null;
      location.systemMessageId = null;
      persistLocation();
      console.warn('System message was deleted; run /dashboard setup again.');
    } else {
      // Transient panel/API hiccup: keep the loop alive, log quietly.
      console.error('System update failed:', err.message ?? err);
    }
  }
}

// Chained timeout (not setInterval) so a slow fetch/edit never overlaps itself.
function runSystemLoop(client) {
  const tick = async () => {
    await updateSystem(client);
    setTimeout(tick, refreshMs);
  };
  tick();
}

export function startUpdater(client) {
  loadLocation();
  updateDashboard(client);
  setInterval(() => updateDashboard(client), DASHBOARD_INTERVAL_MS);
  if (panelConfigured()) runSystemLoop(client);
}
