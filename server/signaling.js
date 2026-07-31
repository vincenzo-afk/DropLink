/**
 * signaling.js
 * ------------
 * Thin message router sitting on top of the WebSocket server.
 *
 * This file NEVER touches file data. Its only job is:
 *   1. Room lifecycle (create / join / leave)
 *   2. Relaying WebRTC signaling payloads (offer / answer / ICE candidates)
 *      between two browsers so they can open a direct DataChannel.
 *   3. Telling a room who else is currently in it.
 *
 * Once two peers have a DataChannel open, this server is no longer part
 * of the conversation between them.
 */

const roomManager = require('./roomManager');

const MAX_USERNAME_LENGTH = 32;
const ROOM_CODE_PATTERN = /^DL-[A-Z0-9]{5}$/;

function sanitizeUsername(raw) {
  const fallback = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().slice(0, MAX_USERNAME_LENGTH);
  return trimmed.length ? trimmed : fallback;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(wss, roomCode, payload, excludeUserId = null) {
  wss.clients.forEach((client) => {
    if (client.roomCode === roomCode && client.userId !== excludeUserId) {
      send(client, payload);
    }
  });
}

function findPeerSocket(wss, roomCode, userId) {
  let target = null;
  wss.clients.forEach((client) => {
    if (client.roomCode === roomCode && client.userId === userId) {
      target = client;
    }
  });
  return target;
}

function handleCreateRoom(ws, msg) {
  const username = sanitizeUsername(msg.username);
  const { roomCode, userId } = roomManager.createRoom(username);

  ws.roomCode = roomCode;
  ws.userId = userId;
  ws.username = username;

  send(ws, { type: 'room-created', roomCode, userId, username, peers: [] });
}

function handleJoinRoom(wss, ws, msg) {
  const roomCode = typeof msg.roomCode === 'string' ? msg.roomCode.trim().toUpperCase() : '';

  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    return send(ws, { type: 'error', code: 'INVALID_CODE', message: 'That room code doesn\u2019t look right.' });
  }

  const username = sanitizeUsername(msg.username);
  const result = roomManager.joinRoom(roomCode, username);

  if (result.error) {
    return send(ws, { type: 'error', code: result.error, message: 'That room doesn\u2019t exist or has expired.' });
  }

  ws.roomCode = roomCode;
  ws.userId = result.userId;
  ws.username = username;

  send(ws, {
    type: 'room-joined',
    roomCode,
    userId: result.userId,
    username,
    peers: result.peers,
  });

  broadcastToRoom(wss, roomCode, {
    type: 'peer-joined',
    userId: result.userId,
    username,
  }, result.userId);
}

function handleSignal(wss, ws, msg) {
  if (!ws.roomCode || !ws.userId) return;
  const target = findPeerSocket(wss, ws.roomCode, msg.target);
  if (!target) return;

  roomManager.touchRoom(ws.roomCode);

  send(target, {
    type: 'signal',
    from: ws.userId,
    username: ws.username,
    data: msg.data,
  });
}

function handleLeaveRoom(wss, ws) {
  if (!ws.roomCode || !ws.userId) return;
  const { roomCode, userId } = ws;

  roomManager.leaveRoom(roomCode, userId);
  broadcastToRoom(wss, roomCode, { type: 'peer-left', userId }, userId);

  ws.roomCode = null;
  ws.userId = null;
}

function handleDisconnect(wss, ws) {
  if (ws.roomCode && ws.userId) {
    handleLeaveRoom(wss, ws);
  }
}

function attachSignaling(wss) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.roomCode = null;
    ws.userId = null;
    ws.username = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        return send(ws, { type: 'error', code: 'BAD_JSON', message: 'Malformed message.' });
      }

      switch (msg.type) {
        case 'create-room':
          return handleCreateRoom(ws, msg);
        case 'join-room':
          return handleJoinRoom(wss, ws, msg);
        case 'signal':
          return handleSignal(wss, ws, msg);
        case 'leave-room':
          return handleLeaveRoom(wss, ws);
        default:
          return send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => handleDisconnect(wss, ws));
    ws.on('error', () => handleDisconnect(wss, ws));
  });

  // Heartbeat: drop dead sockets and clean up their rooms with them.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        handleDisconnect(wss, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));
}

module.exports = { attachSignaling };
