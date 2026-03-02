import 'dotenv/config';

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}


function boundedInt(name, fallback, { min, max }) {
  const n = int(name, fallback);
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || null
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    sttModel: process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe',
    sttFallbackModel: process.env.OPENAI_STT_MODEL_FALLBACK || 'gpt-4o-transcribe',
    translateModel: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4.1-nano',
    translateFallbackModel: process.env.OPENAI_TRANSLATE_MODEL_FALLBACK || 'gpt-4.1-mini'
  },
  overlay: {
    port: boundedInt('OVERLAY_PORT', 3000, { min: 1, max: 65535 }),
    token: process.env.OVERLAY_TOKEN || 'change-me'
  },
  runtime: {
    logLevel: process.env.LOG_LEVEL || 'info',
    silenceFinalMs: boundedInt('SILENCE_FINAL_MS', 700, { min: 200, max: 5000 }),
    bubbleHoldMs: boundedInt('BUBBLE_HOLD_MS', 2500, { min: 500, max: 60_000 }),
    bubbleRemoveMs: boundedInt('BUBBLE_REMOVE_MS', 12000, { min: 1000, max: 300_000 }),
    interimTranslateEveryMs: boundedInt('INTERIM_TRANSLATE_EVERY_MS', 0, { min: 0, max: 60_000 }),
    interimSttEveryMs: boundedInt('INTERIM_STT_EVERY_MS', 2500, { min: 0, max: 60_000 }),
    maxPhraseSeconds: boundedInt('MAX_PHRASE_SECONDS', 25, { min: 3, max: 120 })
  }
};

export function assertConfig() {
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (!config.overlay.token || config.overlay.token === 'change-me') missing.push('OVERLAY_TOKEN');

  if (missing.length) {
    const msg = `Missing env vars: ${missing.join(', ')}. Copy .env.example -> .env and fill them.`;
    throw new Error(msg);
  }
}
