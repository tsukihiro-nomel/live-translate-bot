import { assertConfig } from './config.js';
import { log } from './logger.js';
import { startOverlayServer } from './overlay/server.js';
import { createDiscordClient, startDiscordClient } from './discord/client.js';

async function main() {
  assertConfig();

  startOverlayServer();

  const { client } = createDiscordClient();
  await startDiscordClient(client);

  const shutdown = async () => {
    log.info('Shutting down...');
    try {
      await client.destroy();
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'Fatal');
  process.exit(1);
});
