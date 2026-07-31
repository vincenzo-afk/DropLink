/**
 * server.js
 * ---------
 * Entry point. Boots an Express server for static assets plus a WebSocket
 * server for room + WebRTC signaling.
 *
 * IMPORTANT: this process never sees file contents. Files travel directly
 * between browsers over WebRTC DataChannels. The only bytes that pass
 * through here are room codes, usernames, and WebRTC handshake metadata.
 */

const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const express = require('express');
const { WebSocketServer } = require('ws');

const roomManager = require('./roomManager');
const { attachSignaling } = require('./signaling');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const app = express();

app.disable('x-powered-by');
app.use(express.static(CLIENT_DIR));

// Friendly explicit routes (static middleware already covers these, but
// this keeps behavior obvious and deploy-target agnostic).
app.get('/', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/room', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'room.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: roomManager.getRoomCount(),
    users: roomManager.getActiveUserCount(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * GET /api/preview?url=<encoded url>
 *
 * Best-effort link preview for the chat "link sharing" feature. Fetches
 * the page's <title> only -- nothing is stored, nothing is cached, and
 * failures are silent (the client just shows the raw link).
 */
app.get('/api/preview', (req, res) => {
  const raw = req.query.url;
  let target;
  try {
    target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
  } catch (err) {
    return res.status(400).json({ error: 'INVALID_URL' });
  }

  const client = target.protocol === 'https:' ? https : http;
  const request = client.get(
    target,
    { timeout: 4000, headers: { 'User-Agent': 'DropLink-LinkPreview/1.0' } },
    (upstream) => {
      let body = '';
      let bytes = 0;
      const MAX_BYTES = 100 * 1024; // don't read more than 100KB looking for a <title>

      upstream.on('data', (chunk) => {
        bytes += chunk.length;
        body += chunk.toString('utf8');
        if (bytes > MAX_BYTES) upstream.destroy();
      });

      upstream.on('end', () => {
        const match = body.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = match ? match[1].trim().slice(0, 200) : null;
        res.json({ url: target.href, title });
      });

      upstream.on('close', () => {
        if (!res.headersSent) {
          const match = body.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = match ? match[1].trim().slice(0, 200) : null;
          res.json({ url: target.href, title });
        }
      });
    }
  );

  request.on('timeout', () => request.destroy());
  request.on('error', () => {
    if (!res.headersSent) res.json({ url: target.href, title: null });
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

attachSignaling(wss);
roomManager.startCleanupSweep();

server.listen(PORT, () => {
  console.log(`DropLink server listening on port ${PORT}`);
  console.log(`  → http://localhost:${PORT}`);
});

module.exports = { app, server };
