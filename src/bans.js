import { catAsRoot, writeFileAsRoot } from './root.js';
import { join } from 'node:path';
import config from './config.js';

function getPath(index) {
  return join(config.services[index].cwd, 'banned-players.json');
}

function uuidFormat(hex) {
  if (!hex || hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function resolveUUID(name) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${name}`);
    if (res.ok) {
      const data = await res.json();
      return uuidFormat(data.id);
    }
    return null;
  } catch {
    return null;
  }
}

async function readBanned(index) {
  try {
    const text = await catAsRoot(getPath(index));
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function writeBanned(index, players) {
  const path = getPath(index);
  const content = JSON.stringify(players, null, 2);
  await writeFileAsRoot(path, content);
}

export async function listBannedPlayers(index) {
  return readBanned(index);
}

export async function addBannedPlayer(index, playerName, reason) {
  const players = await readBanned(index);
  const existing = players.find((p) => p.name === playerName);
  if (existing) {
    existing.reason = reason || existing.reason;
    existing.created = existing.created || new Date().toISOString();
    await writeBanned(index, players);
    return { banned: existing, already: true };
  }
  const uuid = await resolveUUID(playerName);
  const entry = {
    name: playerName,
    uuid: uuid || '',
    created: new Date().toISOString(),
    source: 'api',
    expires: null,
    reason: reason || '',
  };
  players.push(entry);
  await writeBanned(index, players);
  return { banned: entry, already: false };
}

export async function removeBannedPlayer(index, playerName) {
  const players = await readBanned(index);
  const before = players.length;
  const filtered = players.filter((p) => p.name !== playerName);
  if (filtered.length === before) return { removed: false, player: playerName };
  await writeBanned(index, filtered);
  return { removed: true, player: playerName };
}
