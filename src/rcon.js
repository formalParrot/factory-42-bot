import { Rcon } from 'rcon-client';

export async function fetchPlayerList() {
  const rcon = await Rcon.connect({
    host: process.env.SURV_RCON_HOST,
    port: Number(process.env.SURV_RCON_PORT),
    password: process.env.SURV_RCON_PASS,
  });
  const res = await rcon.send('list');
  await rcon.end();
  const match = res.match(/online:\s*(.*)$/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(', ').map((s) => s.trim()).filter(Boolean);
}
