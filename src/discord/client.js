import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { handleLiveCommand } from './commands.js';
import { LiveManager } from '../live/liveManager.js';

export function createDiscordClient() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
  });

  const liveManager = new LiveManager({ client });

  client.once('ready', () => {
    log.info({ user: client.user?.tag }, 'Discord client ready');
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'live') {
        await handleLiveCommand({ interaction, liveManager });
      }
    } catch (err) {
      log.warn({ err }, 'Interaction handler error');
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ Erreur interne.', ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: '❌ Erreur interne.', ephemeral: true }).catch(() => {});
      }
    }
  });

  return { client, liveManager };
}

export async function startDiscordClient(client) {
  await client.login(config.discord.token);
}
