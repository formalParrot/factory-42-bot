import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import config from './config.js';
import { snapshotAll } from './services.js';
import { serviceState } from './state.js';

const COLOR_ONLINE = 0x57f287;
const COLOR_OFFLINE = 0xed4245;
const COLOR_PARTIAL = 0xfee75c;

const DATA_DIR = new URL('../data/', import.meta.url);
const DATA_FILE = new URL('../data/dashboard.json', import.meta.url);
export const UPDATE_INTERVAL_MS = 30_000;

let location = null; // { channelId, messageId }

function loadLocation() {
  try {
    location = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    location = null;
  }
}

function clearLocation() {
  location = null;
  try {
    rmSync(DATA_FILE);
  } catch {
    // Already gone.
  }
}

export async function setDashboardMessage(message) {
  if (location && location.messageId !== message.id) {
    try {
      const channel = await message.client.channels.fetch(location.channelId);
      const old = await channel.messages.fetch(location.messageId);
      await old.delete();
    } catch {
      // Old dashboard message no longer exists.
    }
  }
  location = { channelId: message.channelId, messageId: message.id };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(location));
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
      if (snap.running) {
        lines.push(`CPU: ${snap.cpu != null ? `${snap.cpu.toFixed(1)}%` : 'n/a'}`);
        lines.push(`RAM: ${snap.ram ?? 'n/a'}`);
        lines.push(`Uptime: ${snap.uptime ?? 'n/a'}`);
        if (service.ping) {
          lines.push(
            snap.ping
              ? `Players: ${snap.ping.online}/${snap.ping.max}` +
                  (snap.ping.version ? ` (${snap.ping.version})` : '')
              : 'Players: n/a',
          );
        }
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

export async function updateDashboard(client) {
  if (!location) return;
  try {
    const channel = await client.channels.fetch(location.channelId);
    const message = await channel.messages.fetch(location.messageId);
    const snapshots = await snapshotAll();
    await message.edit({
      embeds: [buildStatusEmbed(snapshots)],
      components: buildControlRows(snapshots),
    });
  } catch (err) {
    // 10008 Unknown Message / 10003 Unknown Channel: the dashboard was deleted.
    if (err?.code === 10008 || err?.code === 10003) {
      clearLocation();
      console.warn('Dashboard message was deleted; run /dashboard setup again.');
    } else {
      console.error('Dashboard update failed:', err);
    }
  }
}

export function startUpdater(client) {
  loadLocation();
  updateDashboard(client);
  setInterval(() => updateDashboard(client), UPDATE_INTERVAL_MS);
}
