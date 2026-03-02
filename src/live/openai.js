import { config } from '../config.js';
import { log } from '../logger.js';

const API_BASE = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

function authHeaders() {
  return {
    Authorization: `Bearer ${config.openai.apiKey}`
  };
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeoutSignal(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function fetchWithRetry(url, init, {
  op,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = 3
} = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { signal, clear } = withTimeoutSignal(timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok || !retryableStatus(res.status) || attempt === maxAttempts) {
        clear();
        return res;
      }

      const backoff = Math.min(1200, 250 * 2 ** (attempt - 1));
      clear();
      log.warn({ op, status: res.status, attempt, backoffMs: backoff }, 'OpenAI retryable response');
      await wait(backoff);
    } catch (err) {
      clear();
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      const backoff = Math.min(1200, 250 * 2 ** (attempt - 1));
      log.warn({ op, attempt, backoffMs: backoff, err }, 'OpenAI request failed; retrying');
      await wait(backoff);
    }
  }

  throw lastErr || new Error('OpenAI fetch failed');
}

export async function transcribeWav({ wavBuffer, model, prompt, language }) {
  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);
  if (language) form.append('language', language);

  const res = await fetchWithRetry(`${API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      ...authHeaders()
    },
    body: form
  }, { op: 'stt', timeoutMs: 25_000, maxAttempts: 3 });

  const json = await safeJson(res);
  if (!res.ok) {
    log.warn({ status: res.status, body: json?.error?.message || 'stt_error' }, 'STT failed');
    throw new Error(`STT error ${res.status}`);
  }

  return (json.text || '').trim();
}

function extractOutputText(responseJson) {
  if (!responseJson) return '';
  if (typeof responseJson.output_text === 'string') return responseJson.output_text;

  const out = [];
  if (Array.isArray(responseJson.output)) {
    for (const item of responseJson.output) {
      if (!item || item.type !== 'message') continue;
      if (!Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') out.push(c.text);
        if (c?.type === 'text' && typeof c.text === 'string') out.push(c.text);
      }
    }
  }
  return out.join('\n').trim();
}

export async function translateText({ text, targetLang, glossary, recentContext, model, store = false }) {
  const glossaryLines = Object.entries(glossary || {})
    .slice(0, 200)
    .map(([k, v]) => `- ${k} -> ${v}`)
    .join('\n');

  const sys = [
    'You are a real-time subtitle translator for a livestream.',
    `Translate the user text into ${targetLang}.`,
    'Keep it short and natural. Preserve names and game terms.',
    'Return ONLY the translated text. No quotes, no extra commentary.'
  ];

  if (glossaryLines) {
    sys.push('Glossary rules (must apply if relevant):');
    sys.push(glossaryLines);
  }

  const input = [
    { role: 'system', content: sys.join('\n') }
  ];

  if (Array.isArray(recentContext) && recentContext.length) {
    input.push({
      role: 'user',
      content:
        'Context (previous subtitles, same speaker). Use it for pronouns/consistency, but do not translate it:\n' +
        recentContext.join('\n')
    });
  }

  input.push({ role: 'user', content: text });

  const res = await fetchWithRetry(`${API_BASE}/responses`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input,
      store
    })
  }, { op: 'translate', timeoutMs: 20_000, maxAttempts: 3 });

  const json = await safeJson(res);
  if (!res.ok) {
    log.warn({ status: res.status, body: json?.error?.message || 'translate_error' }, 'Translate failed');
    throw new Error(`Translate error ${res.status}`);
  }

  return extractOutputText(json);
}

export function shouldUpgradeTranslation({ original, translated, transcriptLooksBad }) {
  if (transcriptLooksBad) return true;
  if (!translated) return true;

  const a = (original || '').trim();
  const b = (translated || '').trim();
  if (a && b && a.toLowerCase() === b.toLowerCase()) return true;

  if (a.length > 30 && b.length < Math.max(6, Math.floor(a.length * 0.35))) return true;

  return false;
}
