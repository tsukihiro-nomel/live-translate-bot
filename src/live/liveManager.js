import { getGuildConfig, setGuildConfig } from '../store.js';
import { log } from '../logger.js';
import { VoiceSession } from './voiceSession.js';

export class LiveManager {
  constructor({ client }) {
    this.client = client;
    /** @type {Map<string, VoiceSession>} */
    this.sessions = new Map();
  }

  has(guildId) {
    return this.sessions.has(guildId);
  }

  async start({ guild, voiceChannel, textChannel }) {
    const guildId = guild.id;
    if (this.sessions.has(guildId)) {
      return this.sessions.get(guildId);
    }

    const cfg = await getGuildConfig(guildId);
    const session = new VoiceSession({
      client: this.client,
      guild,
      voiceChannel,
      textChannel,
      getConfig: () => getGuildConfig(guildId)
    });

    await session.start();
    this.sessions.set(guildId, session);

    await setGuildConfig(guildId, { enabled: true });
    log.info({ guildId, vc: voiceChannel.id }, 'Live session started');

    session.once('stopped', async () => {
      this.sessions.delete(guildId);
      await setGuildConfig(guildId, { enabled: false });
      log.info({ guildId }, 'Live session stopped');
    });

    return session;
  }

  async stop(guildId) {
    const s = this.sessions.get(guildId);
    if (!s) return false;
    await s.stop();
    return true;
  }
}
