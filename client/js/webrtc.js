/**
 * webrtc.js
 * ---------
 * Manages a mesh of RTCPeerConnections (one per peer in the room) and
 * the chunked, encrypted file transfer protocol that runs over each
 * peer's DataChannel.
 *
 * The server (see server/signaling.js) is only ever used to relay the
 * SDP offer/answer and ICE candidates needed to open a DataChannel.
 * Once `dc.onopen` fires, every byte — chat text and file chunks —
 * flows directly between the two browsers.
 *
 * Events dispatched (via EventTarget) for room.js / chat.js to consume:
 *   'peer-connected'    { peerId, username }
 *   'peer-disconnected' { peerId }
 *   'peer-status'       { peerId, state }
 *   'chat-message'      { peerId, username, text, timestamp }
 *   'file-incoming'     { transferId, peerId, name, size, fileType, folderPath }
 *   'file-progress'     { transferId, peerId, direction, bytesTransferred, totalBytes, speedBps }
 *   'file-complete'     { transferId, peerId, name, blob, folderPath, size }
 */

const CHUNK_SIZE = 16 * 1024; // 16KB, safe across browsers/SCTP implementations
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024; // pause sending above 4MB queued
const PROGRESS_THROTTLE_MS = 150;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class WebRTCManager extends EventTarget {
  constructor(socket, localUserId, localUsername, cryptoKey) {
    super();
    this.socket = socket;
    this.localUserId = localUserId;
    this.localUsername = localUsername;
    this.cryptoKey = cryptoKey;

    /** @type {Map<string, PeerRecord>} */
    this.peers = new Map();
    this._transferCounter = 0;
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------

  connectToPeer(peerId, username, isInitiator) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const peer = {
      pc,
      dc: null,
      username,
      connected: false,
      pendingCandidates: [],
      sendQueue: [],
      sending: false,
      activeIncomingTransfer: null,
      incomingTransfers: new Map(),
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignal(peerId, { type: 'ice-candidate', candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      this._emit('peer-status', { peerId, state: pc.connectionState });
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this._teardownPeer(peerId);
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('droplink', { ordered: true });
      this._setupDataChannel(peerId, dc);

      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this._sendSignal(peerId, { type: 'offer', sdp: pc.localDescription });
        } catch (err) {
          console.error('DropLink: negotiation failed', err);
        }
      };
    } else {
      pc.ondatachannel = (event) => this._setupDataChannel(peerId, event.channel);
    }

    return peer;
  }

  async handleSignal(fromUserId, fromUsername, data) {
    let peer = this.peers.get(fromUserId);

    if (data.type === 'offer') {
      if (!peer) peer = this.connectToPeer(fromUserId, fromUsername, false);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await this._flushPendingCandidates(peer);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this._sendSignal(fromUserId, { type: 'answer', sdp: peer.pc.localDescription });
      return;
    }

    if (!peer) return; // answer/candidate with no known peer — ignore

    if (data.type === 'answer') {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await this._flushPendingCandidates(peer);
    } else if (data.type === 'ice-candidate' && data.candidate) {
      if (peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn('DropLink: failed to add ICE candidate', err);
        }
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  }

  closePeer(peerId) {
    this._teardownPeer(peerId);
  }

  closeAll() {
    for (const peerId of Array.from(this.peers.keys())) {
      this._teardownPeer(peerId);
    }
  }

  getConnectedCount() {
    let n = 0;
    for (const peer of this.peers.values()) if (peer.connected) n++;
    return n;
  }

  // ---------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------

  async sendChat(text) {
    const timestamp = Date.now();
    const cipher = await window.DropLinkCrypto.encryptText(this.cryptoKey, text);
    const envelope = JSON.stringify({
      type: 'chat',
      from: this.localUserId,
      username: this.localUsername,
      timestamp,
      cipher,
    });

    for (const peer of this.peers.values()) {
      if (peer.dc && peer.dc.readyState === 'open') peer.dc.send(envelope);
    }

    return { timestamp };
  }

  // ---------------------------------------------------------------------
  // File transfer
  // ---------------------------------------------------------------------

  /** Send a File (or a File carrying a folderPath) to every connected peer. */
  sendFileToAll(file, folderPath = null) {
    const transferId = `t${Date.now()}-${this._transferCounter++}`;
    for (const [peerId, peer] of this.peers.entries()) {
      if (!peer.dc || peer.dc.readyState !== 'open') continue;
      peer.sendQueue.push({ transferId, file, folderPath });
      this._pumpSendQueue(peerId);
    }
    return transferId;
  }

  async _pumpSendQueue(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.sending) return;
    const job = peer.sendQueue.shift();
    if (!job) return;

    peer.sending = true;
    try {
      await this._sendFile(peerId, job.transferId, job.file, job.folderPath);
    } catch (err) {
      console.error('DropLink: file send failed', err);
    } finally {
      peer.sending = false;
      if (peer.sendQueue.length) this._pumpSendQueue(peerId);
    }
  }

  async _sendFile(peerId, transferId, file, folderPath) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') return;
    const dc = peer.dc;

    dc.send(JSON.stringify({
      type: 'file-meta',
      transferId,
      name: file.name,
      size: file.size,
      fileType: file.type || 'application/octet-stream',
      folderPath,
    }));

    let offset = 0;
    let lastEmit = 0;
    const startTime = performance.now();

    while (offset < file.size) {
      if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await this._waitForBufferedAmountLow(dc);
      }
      if (dc.readyState !== 'open') return; // peer vanished mid-transfer

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const rawChunk = await slice.arrayBuffer();
      const encrypted = await window.DropLinkCrypto.encryptBuffer(this.cryptoKey, rawChunk);
      dc.send(encrypted);

      offset += rawChunk.byteLength;

      const now = performance.now();
      if (now - lastEmit > PROGRESS_THROTTLE_MS || offset === file.size) {
        lastEmit = now;
        const elapsedSec = (now - startTime) / 1000;
        this._emit('file-progress', {
          transferId,
          peerId,
          direction: 'send',
          bytesTransferred: offset,
          totalBytes: file.size,
          speedBps: elapsedSec > 0 ? offset / elapsedSec : 0,
        });
      }
    }

    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'file-complete', transferId }));
    }
  }

  _waitForBufferedAmountLow(dc) {
    return new Promise((resolve) => {
      dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  _setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    const peer = this.peers.get(peerId);
    peer.dc = dc;

    dc.onopen = () => {
      peer.connected = true;
      this._emit('peer-connected', { peerId, username: peer.username });
    };

    dc.onclose = () => {
      peer.connected = false;
      this._emit('peer-disconnected', { peerId });
    };

    dc.onmessage = (event) => this._handleChannelMessage(peerId, event);
  }

  async _handleChannelMessage(peerId, event) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    if (typeof event.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      return this._handleControlMessage(peerId, peer, msg);
    }

    // Binary payload = an encrypted chunk belonging to the active incoming transfer.
    const transferId = peer.activeIncomingTransfer;
    if (!transferId) return;
    const transfer = peer.incomingTransfers.get(transferId);
    if (!transfer) return;

    const rawBuffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    const decrypted = await window.DropLinkCrypto.decryptBuffer(this.cryptoKey, rawBuffer);

    transfer.chunks.push(decrypted);
    transfer.bytesReceived += decrypted.byteLength;

    const now = performance.now();
    if (now - transfer.lastEmit > PROGRESS_THROTTLE_MS || transfer.bytesReceived >= transfer.size) {
      transfer.lastEmit = now;
      const elapsedSec = (now - transfer.startTime) / 1000;
      this._emit('file-progress', {
        transferId,
        peerId,
        direction: 'receive',
        bytesTransferred: transfer.bytesReceived,
        totalBytes: transfer.size,
        speedBps: elapsedSec > 0 ? transfer.bytesReceived / elapsedSec : 0,
      });
    }
  }

  async _handleControlMessage(peerId, peer, msg) {
    switch (msg.type) {
      case 'file-meta': {
        peer.activeIncomingTransfer = msg.transferId;
        peer.incomingTransfers.set(msg.transferId, {
          name: msg.name,
          size: msg.size,
          fileType: msg.fileType,
          folderPath: msg.folderPath || null,
          chunks: [],
          bytesReceived: 0,
          startTime: performance.now(),
          lastEmit: 0,
        });
        this._emit('file-incoming', {
          transferId: msg.transferId,
          peerId,
          name: msg.name,
          size: msg.size,
          fileType: msg.fileType,
          folderPath: msg.folderPath || null,
        });
        break;
      }
      case 'file-complete': {
        const transfer = peer.incomingTransfers.get(msg.transferId);
        if (!transfer) break;
        const blob = new Blob(transfer.chunks, { type: transfer.fileType });
        this._emit('file-complete', {
          transferId: msg.transferId,
          peerId,
          name: transfer.name,
          blob,
          folderPath: transfer.folderPath,
          size: transfer.size,
        });
        peer.incomingTransfers.delete(msg.transferId);
        if (peer.activeIncomingTransfer === msg.transferId) peer.activeIncomingTransfer = null;
        break;
      }
      case 'chat': {
        const text = await window.DropLinkCrypto.decryptText(this.cryptoKey, msg.cipher);
        this._emit('chat-message', {
          peerId,
          username: msg.username,
          text,
          timestamp: msg.timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  async _flushPendingCandidates(peer) {
    while (peer.pendingCandidates.length) {
      const candidate = peer.pendingCandidates.shift();
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('DropLink: failed to add queued ICE candidate', err);
      }
    }
  }

  _teardownPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      if (peer.dc) peer.dc.close();
      peer.pc.close();
    } catch (err) {
      /* already closed */
    }
    this.peers.delete(peerId);
    this._emit('peer-disconnected', { peerId });
  }

  _sendSignal(target, data) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'signal', target, data }));
    }
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

window.DropLinkWebRTC = { WebRTCManager };
