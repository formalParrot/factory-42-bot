import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import config from './config.js';
import { snapshotAll } from './services.js';
import { serviceState } from './state.js';
import { fetchSystemStats, formatSystemFields, panelConfigured, refreshMs } from './panel.js';

const COLOR_ONLINE = 0x57f287;
const COLOR_OFFLINE = 0xed4245;
const COLOR_PARTIAL = 0xfee75c;

const DATA_DIR = new URL('../data/', import.meta.url);
const DATA_FILE = new URL('../data/dashboard.json', import.meta.url);
export const DASHBOARD_INTERVAL_MS = 30_000;

// { channelId, dashboardMessageId, systemMessageId }
let location = null;
// Cached Message objects so the 1s system loop is a single PATCH, not a fetch chain.
const cache = { dashboard: null, system: null };

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

async function deleteIfPresent(client, messageId) {
  if (!location?.channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(location.channelId);
    const old = await channel.messages.fetch(messageId);
    await old.delete();
  } catch {
    // Already gone.
  }
}

export async function setDashboardMessages(client, dashboardMessage, systemMessage) {
  if (location) {
    await deleteIfPresent(client, location.dashboardMessageId);
    await deleteIfPresent(client, location.systemMessageId);
  }
  location = {
    channelId: dashboardMessage.channelId,
    dashboardMessageId: dashboardMessage.id,
    systemMessageId: systemMessage?.id ?? null,
  };
  cache.dashboard = dashboardMessage;
  cache.system = systemMessage ?? null;
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
            ? `Players: ${snap.ping.online}/${snap.ping.max}` +
                (snap.ping.version ? ` (${snap.ping.version})` : '')
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
  return new EmbedBuilder()
    .setTitle('System')
    .setColor(f.online ? COLOR_ONLINE : COLOR_OFFLINE)
    .addFields(
      { name: 'Uptime', value: f.uptime, inline: true },
      { name: 'CPU', value: f.cpu, inline: true },
      { name: 'RAM', value: f.ram, inline: true },
    )
    .setTimestamp(new Date());
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

async function resolveMessage(client, which, messageId) {
  if (cache[which]) return cache[which];
  const channel = await client.channels.fetch(location.channelId);
  cache[which] = await channel.messages.fetch(messageId);
  return cache[which];
}

export async function updateDashboard(client) {
  if (!location?.dashboardMessageId) return;
  try {
    const message = await resolveMessage(client, 'dashboard', location.dashboardMessageId);
    const snapshots = await snapshotAll();
    await message.edit({
      embeds: [buildStatusEmbed(snapshots)],
      components: buildControlRows(snapshots),
    });
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

async function updateSystem(client) {
  if (!location?.systemMessageId || !panelConfigured()) return;
  try {
    const stats = await fetchSystemStats();
    const message = await resolveMessage(client, 'system', location.systemMessageId);
    await message.edit({ embeds: [buildSystemEmbed(stats)] });
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
