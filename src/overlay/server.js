import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from '../config.js';
import { log } from '../logger.js';
import { bus } from '../live/bus.js';
import { getGuildConfig } from '../store.js';

function jsonSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

export function startOverlayServer() {
  const app = express();

  const publicDir = path.resolve('./public');
  app.use('/static', express.static(publicDir, { fallthrough: true }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Nice short route for OBS
  app.get(['/overlay', '/'], (req, res) => {
    res.sendFile(path.join(publicDir, 'overlay.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024
  });

  /** @type {Set<{ ws: import('ws').WebSocket, guildId: string | null }>} */
  const clients = new Set();
  const connectionsPerIp = new Map();
  const MAX_WS_PER_IP = 10;

  // Minimal state cache to rehydrate overlay on refresh
  const stateByGuild = new Map(); // guildId -> { speakers: Map, captions: Map }

  function ensureGuildState(guildId) {
    const key = guildId || '__global__';
    if (!stateByGuild.has(key)) {
      stateByGuild.set(key, { speakers: new Map(), captions: new Map() });
    }
    return stateByGuild.get(key);
  }

  function broadcast(obj, guildId = null) {
    for (const client of clients) {
      if (client.guildId && guildId && client.guildId !== guildId) continue;
      if (client.guildId && !guildId) continue;
      jsonSend(client.ws, obj);
    }
  }

  // Wire bus -> ws
  bus.on('speaker.update', (ev) => {
    const g = ensureGuildState(ev.guildId);
    g.speakers.set(ev.speaker.id, ev.speaker);
    broadcast({ type: 'speaker.update', ...ev }, ev.guildId);
  });

  bus.on('speaker.activity', (ev) => {
    broadcast({ type: 'speaker.activity', ...ev }, ev.guildId);
  });

  bus.on('caption.interim', (ev) => {
    const g = ensureGuildState(ev.guildId);
    g.captions.set(ev.speaker.id, { id: ev.id, text: ev.text, ts: ev.ts });
    broadcast({ type: 'caption.interim', ...ev }, ev.guildId);
  });

  bus.on('caption.final', (ev) => {
    const g = ensureGuildState(ev.guildId);
    g.captions.set(ev.speaker.id, { id: ev.id, text: ev.text, ts: ev.ts });
    broadcast({ type: 'caption.final', ...ev }, ev.guildId);
  });

  bus.on('status', (ev) => {
    broadcast({ type: 'status', ...ev }, ev.guildId);
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const guildId = url.searchParams.get('guild');

    const ip = req.socket.remoteAddress || 'unknown';
    const count = (connectionsPerIp.get(ip) || 0) + 1;
    connectionsPerIp.set(ip, count);
    if (count > MAX_WS_PER_IP) {
      ws.close(1013, 'Too many connections');
      connectionsPerIp.set(ip, count - 1);
      return;
    }

    const accept = async () => {
      if (token && token === config.overlay.token) return true;
      if (guildId && token) {
        try {
          const cfg = await getGuildConfig(guildId);
          if (cfg.overlayToken && cfg.overlayToken === token) return true;
        } catch {
          // ignore
        }
      }
      return false;
    };

    accept().then((ok) => {
      if (!ok) {
        ws.close(1008, 'Invalid token');
        return;
      }

      const guildState = ensureGuildState(guildId);
      const clientRef = { ws, guildId: guildId || null };
      clients.add(clientRef);
      log.info({ clients: clients.size, guildId: guildId || null }, 'Overlay WS connected');

      // Initial state
      jsonSend(ws, {
        type: 'state.init',
        ts: Date.now(),
        config: {
          holdMs: config.runtime.bubbleHoldMs,
          removeMs: config.runtime.bubbleRemoveMs
        },
        speakers: Array.from(guildState.speakers.values()),
        captions: Array.from(guildState.captions.entries()).map(([speakerId, cap]) => ({ speakerId, ...cap }))
      });

      ws.on('close', () => {
        clients.delete(clientRef);
        const next = (connectionsPerIp.get(ip) || 1) - 1;
        if (next <= 0) connectionsPerIp.delete(ip);
        else connectionsPerIp.set(ip, next);
        log.info({ clients: clients.size, guildId: guildId || null }, 'Overlay WS disconnected');
      });

      ws.on('error', () => {
        ws.close();
      });
    }).catch(() => {
      ws.close(1011, 'Auth check failed');
    });
  });

  server.listen(config.overlay.port, () => {
    log.info({ port: config.overlay.port }, 'Overlay server listening');
  });

  return { server, wss };
}
