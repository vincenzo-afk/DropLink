/**
 * roomManager.js
 * ---------------
 * Pure in-memory room management for DropLink.
 *
 * No database. No disk writes. Everything lives in a single Map for the
 * lifetime of the process, which is exactly what a "temporary room"
 * platform needs: as soon as a room is empty for too long, it disappears
 * along with every trace of who was in it.
 */

const crypto = require('crypto');

// roomCode -> { code, users: Map<userId, {username, joinedAt}>, createdAt, lastActivity, emptySince }
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 (avoid ambiguity)
const ROOM_CODE_LENGTH = 5;
const EMPTY_ROOM_GRACE_MS = 2 * 60 * 1000; // keep an empty room alive for 2 min (page refresh, etc.)
const INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // hard limit: 30 min with no activity
const SWEEP_INTERVAL_MS = 30 * 1000;

function generateRoomCode() {
  let code;
  do {
    let suffix = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      suffix += ROOM_CODE_CHARS[crypto.randomInt(0, ROOM_CODE_CHARS.length)];
    }
    code = `DL-${suffix}`;
  } while (rooms.has(code));
  return code;
}

function generateUserId() {
  return crypto.randomUUID();
}

function createRoom(username) {
  const code = generateRoomCode();
  const userId = generateUserId();
  const now = Date.now();

  const room = {
    code,
    users: new Map([[userId, { username, joinedAt: now }]]),
    createdAt: now,
    lastActivity: now,
    emptySince: null,
  };

  rooms.set(code, room);
  return { roomCode: code, userId };
}

function joinRoom(roomCode, username) {
  const room = rooms.get(roomCode);
  if (!room) {
    return { error: 'ROOM_NOT_FOUND' };
  }

  const userId = generateUserId();
  const peers = getPeerList(roomCode);

  room.users.set(userId, { username, joinedAt: Date.now() });
  room.lastActivity = Date.now();
  room.emptySince = null;

  return { userId, peers };
}

function leaveRoom(roomCode, userId) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.users.delete(userId);
  room.lastActivity = Date.now();

  if (room.users.size === 0) {
    room.emptySince = Date.now();
  }
}

function touchRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) room.lastActivity = Date.now();
}

function getPeerList(roomCode, excludeUserId = null) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  const peers = [];
  for (const [userId, info] of room.users.entries()) {
    if (userId !== excludeUserId) {
      peers.push({ userId, username: info.username });
    }
  }
  return peers;
}

function roomExists(roomCode) {
  return rooms.has(roomCode);
}

function getUsername(roomCode, userId) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const user = room.users.get(userId);
  return user ? user.username : null;
}

function getRoomCount() {
  return rooms.size;
}

function getActiveUserCount() {
  let total = 0;
  for (const room of rooms.values()) total += room.users.size;
  return total;
}

/**
 * Periodically sweep and evict rooms that have been empty past their grace
 * period, or that have simply gone stale (nobody has done anything in a
 * long time, e.g. an abandoned tab that never sent a clean "leave").
 */
function startCleanupSweep() {
  return setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      const isEmpty = room.users.size === 0;
      const emptyTooLong = isEmpty && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS;
      const staleTooLong = now - room.lastActivity > INACTIVITY_LIMIT_MS;

      if (emptyTooLong || staleTooLong) {
        rooms.delete(code);
      }
    }
  }, SWEEP_INTERVAL_MS);
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  touchRoom,
  getPeerList,
  roomExists,
  getUsername,
  getRoomCount,
  getActiveUserCount,
  startCleanupSweep,
};
