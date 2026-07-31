/**
 * crypto.js
 * ---------
 * Everything sent over a DataChannel — file chunks and chat text — is
 * encrypted client-side with AES-256-GCM before it ever leaves the
 * browser. The server never has the key: it's derived entirely from the
 * room code, which only travels through the (already end-to-end) WebRTC
 * handshake or is shared out-of-band by whoever created the room.
 *
 * This is a lightweight, room-shared-secret scheme suitable for a
 * temporary sharing session — not a substitute for a full authenticated
 * key-exchange protocol.
 */

const IV_LENGTH = 12; // bytes, standard for AES-GCM

/**
 * Derive an AES-GCM CryptoKey from the room code using PBKDF2.
 * Every peer in the room runs this with the same room code, so every
 * peer ends up with the same symmetric key without ever transmitting it.
 */
async function deriveRoomKey(roomCode) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(roomCode),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('droplink-room-salt-v1'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt an ArrayBuffer (e.g. a file chunk). Returns a new ArrayBuffer
 * with the random IV prepended to the ciphertext so the receiver can
 * pull it straight back out.
 */
async function encryptBuffer(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);

  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return combined.buffer;
}

/**
 * Reverse of encryptBuffer: expects the IV prepended to the ciphertext.
 */
async function decryptBuffer(key, arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

/** Convenience wrapper for encrypting a UTF-8 string (chat messages). */
async function encryptText(key, text) {
  const encoded = new TextEncoder().encode(text);
  const buffer = await encryptBuffer(key, encoded.buffer);
  return arrayBufferToBase64(buffer);
}

/** Convenience wrapper for decrypting back to a UTF-8 string. */
async function decryptText(key, base64) {
  const buffer = base64ToArrayBuffer(base64);
  const plaintext = await decryptBuffer(key, buffer);
  return new TextDecoder().decode(plaintext);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

window.DropLinkCrypto = {
  deriveRoomKey,
  encryptBuffer,
  decryptBuffer,
  encryptText,
  decryptText,
};
