import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { liveCommand } from '../src/discord/commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const commands = [liveCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(token);

async function run() {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`✅ Deployed guild commands to ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Deployed global commands (can take up to ~1h to appear)');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
