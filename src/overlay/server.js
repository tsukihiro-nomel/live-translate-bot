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
  const wss = new WebSocketServer({ server, path: '/ws' });

  /** @type {Set<import('ws').WebSocket>} */
  const clients = new Set();

  // Minimal state cache to rehydrate overlay on refresh
  const state = {
    speakers: new Map(), // id -> speaker
    captions: new Map() // speakerId -> { id, text, ts }
  };

  function broadcast(obj) {
    for (const ws of clients) jsonSend(ws, obj);
  }

  // Wire bus -> ws
  bus.on('speaker.update', (ev) => {
    state.speakers.set(ev.speaker.id, ev.speaker);
    broadcast({ type: 'speaker.update', ...ev });
  });

  bus.on('speaker.activity', (ev) => {
    broadcast({ type: 'speaker.activity', ...ev });
  });

  bus.on('caption.interim', (ev) => {
    state.captions.set(ev.speaker.id, { id: ev.id, text: ev.text, ts: ev.ts });
    broadcast({ type: 'caption.interim', ...ev });
  });

  bus.on('caption.final', (ev) => {
    state.captions.set(ev.speaker.id, { id: ev.id, text: ev.text, ts: ev.ts });
    broadcast({ type: 'caption.final', ...ev });
  });

  bus.on('status', (ev) => {
    broadcast({ type: 'status', ...ev });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const guildId = url.searchParams.get('guild');

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

      clients.add(ws);
      log.info({ clients: clients.size }, 'Overlay WS connected');

      // Initial state
      jsonSend(ws, {
        type: 'state.init',
        ts: Date.now(),
        config: {
          holdMs: config.runtime.bubbleHoldMs,
          removeMs: config.runtime.bubbleRemoveMs
        },
        speakers: Array.from(state.speakers.values()),
        captions: Array.from(state.captions.entries()).map(([speakerId, cap]) => ({ speakerId, ...cap }))
      });

      ws.on('close', () => {
        clients.delete(ws);
        log.info({ clients: clients.size }, 'Overlay WS disconnected');
      });
    });
  });

  server.listen(config.overlay.port, () => {
    log.info({ port: config.overlay.port }, 'Overlay server listening');
  });

  return { server, wss };
}
