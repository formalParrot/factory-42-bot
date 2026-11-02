import { ChannelType, SlashCommandBuilder } from 'discord.js';

const postableChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export const commandData = [
  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Manage the live server dashboard')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Post the live server status in this channel'),
    )
    .addSubcommand((sub) =>
      sub.setName('controls').setDescription('Post only the server controls panel in this channel'),
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show a one-time status snapshot of all services'),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement embed')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to post in (defaults to the current one)')
        .addChannelTypes(...postableChannels),
    ),
  new SlashCommandBuilder()
    .setName('modpack')
    .setDescription('Post a modpack update with version and changelog')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('The .mrpack or .zip file').setRequired(true),
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to post in (defaults to the current one)')
        .addChannelTypes(...postableChannels),
    ),
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage the server whitelist')
    .addSubcommand((sub) =>
      sub.setName('setup').setDescription('Post the whitelist request panel'),
    )
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('View linked whitelisted users'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a Discord user from the whitelist')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Discord user to remove').setRequired(true),
        ),
    ),
].map((command) => command.toJSON());

export async function registerCommands(client) {
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    await client.application.commands.set(commandData, guildId);
    console.log(`Registered ${commandData.length} guild commands.`);
  } else {
    await client.application.commands.set(commandData);
    console.log(`Registered ${commandData.length} global commands (may take up to an hour to appear).`);
  }
}
