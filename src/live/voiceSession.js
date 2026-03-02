import { EventEmitter } from 'node:events';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} from '@discordjs/voice';
import prism from 'prism-media';

import { config } from '../config.js';
import { log } from '../logger.js';
import { bus } from './bus.js';
import { pcmToWav } from './wav.js';
import { transcribeWav, translateText, shouldUpgradeTranslation } from './openai.js';

function now() {
  return Date.now();
}

function clampArray(arr, max) {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

function pcmRms16leStereo(pcm) {
  // PCM S16LE interleaved, 2 channels. Returns RMS in [0..32768]
  if (!pcm || pcm.length < 4) return 0;
  const samples = Math.floor(pcm.length / 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2);
    sumSq += v * v;
  }
  const meanSq = sumSq / samples;
  return Math.sqrt(meanSq);
}

export class VoiceSession extends EventEmitter {
  constructor({ client, guild, voiceChannel, textChannel, getConfig }) {
    super();
    this.client = client;
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.getConfig = getConfig;

    this.connection = null;
    this.activeCaptures = new Map(); // userId -> capture
    this.speakerCache = new Map(); // userId -> { id, name, avatar }
    this.recentTranslations = new Map(); // userId -> [last translations]

    this._queue = Promise.resolve();
    this._utteranceSeq = 0;
    this._stopped = false;
  }

  enqueue(fn) {
    this._queue = this._queue.then(fn).catch((err) => {
      log.warn({ err, guildId: this.guild?.id }, 'Queued task failed');
    });
    return this._queue;
  }

  async start() {
    const c = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true
    });

    this.connection = c;

    c.on('stateChange', (oldState, newState) => {
      log.debug({ from: oldState.status, to: newState.status }, 'Voice state change');
    });

    c.on('error', (err) => {
      log.warn({ err, guildId: this.guild.id }, 'Voice connection error');
    });

    c.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        void this.stop();
      }
    });

    await entersState(c, VoiceConnectionStatus.Ready, 30_000);

    // Consent notice (public message)
    try {
      await this.textChannel.send(
        '⚠️ **Traduction live active** dans ce vocal. La voix est transcrite puis traduite en direct (pas de sauvegarde côté bot).'
      );
    } catch (e) {
      log.warn({ err: e }, 'Could not send consent message');
    }

    const receiver = c.receiver;

    receiver.speaking.on('start', (userId) => {
      this._onSpeakingStart(userId).catch((err) => log.warn({ err, userId }, 'start handler failed'));
    });

    receiver.speaking.on('end', (userId) => {
      // NOTE: this can fire slightly before the stream ends; we handle finalization on stream end.
      bus.emit('speaker.activity', { guildId: this.guild.id, speakerId: userId, state: 'end', ts: now() });
    });

    bus.emit('status', { guildId: this.guild.id, status: 'live.on', ts: now() });
  }

  async stop() {
    if (this._stopped && !this.connection) return;
    this._stopped = true;
    for (const cap of this.activeCaptures.values()) {
      cap.stop?.();
    }
    this.activeCaptures.clear();

    try {
      this.connection?.destroy();
    } catch {
      // ignore
    }
    this.connection = null;

    bus.emit('status', { guildId: this.guild.id, status: 'live.off', ts: now() });
    this.emit('stopped');
  }

  async _getSpeaker(userId) {
    if (this.speakerCache.has(userId)) return this.speakerCache.get(userId);

    let member = null;
    try {
      member = await this.guild.members.fetch(userId);
    } catch {
      // user left or not fetchable
    }

    const user = member?.user;
    const speaker = {
      id: userId,
      name: member?.displayName || user?.username || `user-${userId}`,
      avatar: user?.displayAvatarURL({ extension: 'png', size: 128 }) || null
    };

    this.speakerCache.set(userId, speaker);
    bus.emit('speaker.update', { guildId: this.guild.id, speaker, ts: now() });
    return speaker;
  }

  _nextUtteranceId(userId) {
    this._utteranceSeq += 1;
    return `${this.guild.id}:${userId}:${now()}:${this._utteranceSeq}`;
  }

  async _onSpeakingStart(userId) {
    if (!this.connection || this._stopped) return;

    // Already capturing? (avoid double subscriptions)
    if (this.activeCaptures.has(userId)) return;

    const cfg = await this.getConfig();
    const speaker = await this._getSpeaker(userId);

    const utteranceId = this._nextUtteranceId(userId);

    bus.emit('speaker.activity', { guildId: this.guild.id, speakerId: userId, state: 'start', ts: now() });

    const receiver = this.connection.receiver;

    // Subscribe to Opus for this user, end when we see SILENCE_FINAL_MS of silence.
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.runtime.silenceFinalMs
      }
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    });

    const pcmChunks = [];
    let pcmBytes = 0;
    const startedAt = now();
    let lastInterimAt = 0;
    let lastInterimTranslateAt = 0;
    let ended = false;

    const stop = () => {
      if (ended) return;
      ended = true;
      try { opusStream.destroy(); } catch {}
      try { decoder.destroy(); } catch {}
    };

    const cap = { stop };
    this.activeCaptures.set(userId, cap);

    const forceMaxTimer = setTimeout(() => {
      // Force end if someone monologues too long.
      stop();
    }, config.runtime.maxPhraseSeconds * 1000);

    const maybeInterimTick = async () => {
      if (ended) return;
      const t = now();
      const every = config.runtime.interimSttEveryMs;
      if (!every || every <= 0) return;
      if (t - lastInterimAt < every) return;
      lastInterimAt = t;

      const pcm = Buffer.concat(pcmChunks);
      const durationSec = pcm.length / (48000 * 2 * 2);
      const rms = pcmRms16leStereo(pcm);
      if (durationSec < 0.35 || rms < 320) return;

      const wav = pcmToWav(pcm);
      const prompt = this._makeSttPrompt(userId);

      // Interim STT call (queued)
      this.enqueue(async () => {
        if (ended || this._stopped) return;
        const interimText = await this._sttWithFallback({ wav, prompt });
        if (!interimText) return;

        // Interim translation (optional / throttled)
        let translated = null;
        const trEvery = config.runtime.interimTranslateEveryMs;
        if (trEvery && trEvery > 0 && t - lastInterimTranslateAt >= trEvery) {
          lastInterimTranslateAt = t;
          translated = await this._translateWithFallback({
            text: interimText,
            targetLang: cfg.targetLang,
            glossary: cfg.glossary,
            speakerId: userId
          });
        }

        if (translated) {
          bus.emit('caption.interim', {
            guildId: this.guild.id,
            id: utteranceId,
            speaker,
            text: translated,
            ts: now()
          });
        }
      });
    };

    decoder.on('data', (buf) => {
      if (ended) return;
      pcmChunks.push(buf);
      pcmBytes += buf.length;

      // Lightweight tick for interim STT.
      void maybeInterimTick();

      // Safety: if we exceed max length by bytes, we stop.
      const maxBytes = config.runtime.maxPhraseSeconds * 48000 * 2 * 2; // seconds * sampleRate * bytesPerSample * channels
      if (pcmBytes >= maxBytes) {
        stop();
      }
    });

    const finalize = async () => {
      if (ended) return;
      ended = true;
      clearTimeout(forceMaxTimer);

      this.activeCaptures.delete(userId);

      const pcm = Buffer.concat(pcmChunks);
      const durationSec = pcm.length / (48000 * 2 * 2);
      const rms = pcmRms16leStereo(pcm);

      // Cheap VAD gate: don't pay STT for near-silence / ultra short blips.
      if (durationSec < 0.25 || rms < 320) {
        return;
      }

      const wav = pcmToWav(pcm);
      const prompt = this._makeSttPrompt(userId);

      this.enqueue(async () => {
        if (this._stopped) return;
        const cfg2 = await this.getConfig();

        const transcript = await this._sttWithFallback({ wav, prompt });
        const transcriptLooksBad = !transcript || /\b(inaudible|\[inaudible\]|\?\?\?)\b/i.test(transcript);

        if (!transcript) return;

        const translated = await this._translateWithFallback({
          text: transcript,
          targetLang: cfg2.targetLang,
          glossary: cfg2.glossary,
          speakerId: userId,
          transcriptLooksBad
        });

        if (!translated) return;

        // Keep short per-speaker context in target language.
        const arr = this.recentTranslations.get(userId) || [];
        arr.push(translated);
        this.recentTranslations.set(userId, clampArray(arr, 3));

        bus.emit('caption.final', {
          guildId: this.guild.id,
          id: utteranceId,
          speaker,
          text: translated,
          ts: now(),
          meta: {
            ms: now() - startedAt,
            chars: transcript.length
          }
        });
      });

      bus.emit('speaker.activity', { guildId: this.guild.id, speakerId: userId, state: 'final', ts: now() });
    };

    decoder.on('end', finalize);
    decoder.on('close', finalize);

    opusStream.on('error', (err) => {
      log.warn({ err, userId }, 'Opus stream error');
    });

    decoder.on('error', (err) => {
      log.warn({ err, userId }, 'Decoder error');
    });

    opusStream.pipe(decoder);

    // When opus stream ends, decoder will end.
    opusStream.on('end', () => {
      // decoder end will trigger finalize
    });

    // If forced stop happened, finalize won't run, so we trigger it.
    const stopWatcher = setInterval(() => {
      if (!ended) return;
      clearInterval(stopWatcher);
      clearTimeout(forceMaxTimer);
      // finalize may already have run; safe.
    }, 200);

    // Also: if we stopped (max) we want to finalize immediately.
    const originalStop = stop;
    cap.stop = () => {
      const wasEnded = ended;
      originalStop();
      if (!wasEnded) void finalize();
    };
  }

  _makeSttPrompt(userId) {
    // Optional prompt hint for continuity.
    const ctx = this.recentTranslations.get(userId) || [];
    if (!ctx.length) return '';
    // Keep it short; prompt should match audio language, but we only have translated context.
    // Better than nothing; you can disable by returning ''.
    return '';
  }

  async _sttWithFallback({ wav, prompt }) {
    const primary = config.openai.sttModel;
    const fallback = config.openai.sttFallbackModel;

    try {
      return await transcribeWav({ wavBuffer: wav, model: primary, prompt });
    } catch (e) {
      log.warn({ err: e, guildId: this.guild.id }, 'Primary STT failed; trying fallback');
      try {
        return await transcribeWav({ wavBuffer: wav, model: fallback, prompt });
      } catch (e2) {
        log.warn({ err: e2, guildId: this.guild.id }, 'Fallback STT failed');
        return '';
      }
    }
  }

  async _translateWithFallback({ text, targetLang, glossary, speakerId, transcriptLooksBad = false }) {
    const primary = config.openai.translateModel;
    const fallback = config.openai.translateFallbackModel;

    const recentContext = this.recentTranslations.get(speakerId) || [];

    let translated = '';
    try {
      translated = await translateText({
        text,
        targetLang,
        glossary,
        recentContext,
        model: primary,
        store: false
      });
    } catch (e) {
      log.warn({ err: e, guildId: this.guild.id }, 'Primary translate failed');
    }

    const upgrade = shouldUpgradeTranslation({ original: text, translated, transcriptLooksBad });
    if (!upgrade) return translated;

    try {
      const better = await translateText({
        text,
        targetLang,
        glossary,
        recentContext,
        model: fallback,
        store: false
      });
      return better || translated;
    } catch (e) {
      log.warn({ err: e, guildId: this.guild.id }, 'Fallback translate failed');
      return translated;
    }
  }
}
