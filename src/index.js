import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { registerCommands } from './commands.js';
import { startUpdater } from './dashboard.js';
import { handleInteraction } from './interactions.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await registerCommands(client);
  startUpdater(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error('Interaction failed:', err);
    const payload = {
      content: 'Something went wrong while handling that action.',
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else if (interaction.isRepliable()) await interaction.reply(payload);
    } catch {
      // Interaction already expired.
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
