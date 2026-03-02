import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('./data');
const FILE = path.join(DATA_DIR, 'guilds.json');

const DEFAULT_GUILD = {
  enabled: false,
  targetLang: 'fr',
  overlayToken: null,
  glossary: {},
  overlayOrder: 'fixed' // 'fixed' | 'activity'
};

let cache = null;

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

async function loadAll() {
  if (cache) return cache;
  await ensure();
  const raw = await fs.readFile(FILE, 'utf8');
  cache = JSON.parse(raw || '{}');
  return cache;
}

async function saveAll(obj) {
  cache = obj;
  await fs.writeFile(FILE, JSON.stringify(obj, null, 2), 'utf8');
}

export async function getGuildConfig(guildId) {
  const all = await loadAll();
  const cfg = all[guildId] || {};
  return { ...DEFAULT_GUILD, ...cfg };
}

export async function setGuildConfig(guildId, patch) {
  const all = await loadAll();
  const current = all[guildId] || {};
  all[guildId] = { ...DEFAULT_GUILD, ...current, ...patch };
  await saveAll(all);
  return all[guildId];
}

export async function updateGuildGlossary(guildId, updater) {
  const cfg = await getGuildConfig(guildId);
  const nextGlossary = updater({ ...(cfg.glossary || {}) });
  return setGuildConfig(guildId, { glossary: nextGlossary });
}
