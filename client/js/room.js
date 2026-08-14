/**
 * room.js
 * -------
 * Orchestrates everything on room.html: opens the signaling WebSocket,
 * creates/joins the room, wires up the WebRTC mesh, and drives every
 * piece of room UI (room code, QR, user list, drag & drop, progress
 * bars, chat, folder reconstruction, theme, connection status).
 */

(function () {
  const THEME_KEY = 'droplink:theme';
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action'); // 'create' | 'join'
  const requestedCode = (params.get('code') || '').toUpperCase();
  // Client-side sanitization mirrors the server's (signaling.js sanitizeUsername):
  // trimmed, non-empty fallback, capped length. Prevents blank or overlong
  // display names from reaching the server.
  const MAX_USERNAME_LENGTH = 32;
  const rawUsername = params.get('username') || '';
  let username = rawUsername.trim().slice(0, MAX_USERNAME_LENGTH);
  if (!username) {
    username = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  // ---- DOM refs ---------------------------------------------------------
  const el = {
    roomCode: document.getElementById('roomCodeValue'),
    copyBtn: document.getElementById('copyCodeBtn'),
    qr: document.getElementById('qrCode'),
    qrDownload: document.getElementById('qrDownloadBtn'),
    userList: document.getElementById('userList'),
    userCount: document.getElementById('userCount'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    folderInput: document.getElementById('folderInput'),
    transferList: document.getElementById('transferList'),
    receivedList: document.getElementById('receivedList'),
    chatMessages: document.getElementById('chatMessages'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),
    themeToggle: document.getElementById('themeToggle'),
    toastHost: document.getElementById('toastHost'),
    leaveBtn: document.getElementById('leaveRoomBtn'),
  };

  // ---- Theme --------------------------------------------------------------
  document.documentElement.setAttribute('data-theme', localStorage.getItem(THEME_KEY) || 'dark');
  if (el.themeToggle) {
    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
    });
  }

  // ---- Toasts ---------------------------------------------------------
  function toast(message, type = 'info') {
    if (!el.toastHost) return;
    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    node.textContent = message;
    el.toastHost.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-visible'));
    setTimeout(() => {
      node.classList.remove('is-visible');
      setTimeout(() => node.remove(), 300);
    }, 4000);
  }

  // ---- State ------------------------------------------------------------
  let socket = null;
  let roomCode = null;
  let localUserId = null;
  let webrtcManager = null;
  let cryptoKey = null;
  const roomMembers = new Map(); // userId -> username (everyone the server says is in the room)
  const peerConnState = new Map(); // userId -> 'connecting' | 'connected' | 'disconnected'
  const folderBuckets = new Map(); // `${peerId}::${folderName}` -> { name, files: Map, el, countEl }

  function setConnectionStatus(state, text) {
    if (!el.statusDot) return;
    el.statusDot.className = `status-dot status-dot--${state}`;
    el.statusText.textContent = text;
  }

  // ---- Bootstrap ----------------------------------------------------------
  if (!action || (action === 'join' && !/^DL-[A-Z0-9]{5}$/.test(requestedCode))) {
    window.location.href = 'index.html';
    return;
  }

  connect();

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);
    setConnectionStatus('connecting', 'Connecting…');

    socket.addEventListener('open', () => {
      if (action === 'create') {
        socket.send(JSON.stringify({ type: 'create-room', username }));
      } else {
        socket.send(JSON.stringify({ type: 'join-room', roomCode: requestedCode, username }));
      }
    });

    socket.addEventListener('message', (event) => handleServerMessage(JSON.parse(event.data)));

    socket.addEventListener('close', () => {
      setConnectionStatus('disconnected', 'Disconnected from server');
    });

    socket.addEventListener('error', () => {
      setConnectionStatus('disconnected', 'Connection error');
    });
  }

  async function handleServerMessage(msg) {
    switch (msg.type) {
      case 'room-created':
      case 'room-joined': {
        roomCode = msg.roomCode;
        localUserId = msg.userId;
        setConnectionStatus('connected', 'Connected');
        renderRoomCode(roomCode);
        renderQrCode(roomCode);

        // Use the server-sanitized username for our own "you" entry so the
        // self label always matches what peers see (the URL param is not
        // trusted — the server is the source of truth for display names).
        const sanitizedSelfName = msg.username;
        roomMembers.set(localUserId, `${sanitizedSelfName} (you)`);
        msg.peers.forEach((p) => roomMembers.set(p.userId, p.username));
        renderUserList();

        cryptoKey = await window.DropLinkCrypto.deriveRoomKey(roomCode);
        webrtcManager = new window.DropLinkWebRTC.WebRTCManager(socket, localUserId, sanitizedSelfName, cryptoKey);
        wireWebrtcEvents();

        // We are the "newcomer" relative to everyone already in the room,
        // so we initiate the connection to each of them.
        msg.peers.forEach((p) => {
          peerConnState.set(p.userId, 'connecting');
          webrtcManager.connectToPeer(p.userId, p.username, true);
        });
        renderUserList();

        if (action === 'create') {
          toast('Room created. Share the code or QR to invite others.', 'success');
        }
        break;
      }

      case 'peer-joined': {
        roomMembers.set(msg.userId, msg.username);
        peerConnState.set(msg.userId, 'connecting');
        renderUserList();
        toast(`${msg.username} joined the room`, 'info');
        // They will initiate the WebRTC offer to us; we just wait for it.
        break;
      }

      case 'peer-left': {
        const name = roomMembers.get(msg.userId);
        roomMembers.delete(msg.userId);
        peerConnState.delete(msg.userId);
        if (webrtcManager) webrtcManager.closePeer(msg.userId);
        renderUserList();
        if (name) toast(`${name} left the room`, 'info');
        break;
      }

      case 'signal': {
        if (webrtcManager) await webrtcManager.handleSignal(msg.from, msg.username, msg.data);
        break;
      }

      case 'error': {
        toast(msg.message || 'Something went wrong.', 'error');
        if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'INVALID_CODE') {
          setTimeout(() => (window.location.href = 'index.html'), 1800);
        }
        break;
      }

      default:
        break;
    }
  }

  // ---- WebRTC event wiring ----------------------------------------------
  function wireWebrtcEvents() {
    webrtcManager.addEventListener('peer-status', (e) => {
      const { peerId, state } = e.detail;
      peerConnState.set(peerId, state === 'connected' ? 'connected' : state === 'failed' || state === 'closed' ? 'disconnected' : 'connecting');
      renderUserList();
    });

    webrtcManager.addEventListener('peer-connected', (e) => {
      peerConnState.set(e.detail.peerId, 'connected');
      renderUserList();
    });

    webrtcManager.addEventListener('peer-disconnected', (e) => {
      peerConnState.set(e.detail.peerId, 'disconnected');
      renderUserList();
    });

    webrtcManager.addEventListener('chat-message', (e) => {
      window.DropLinkChat.renderMessage(el.chatMessages, {
        username: e.detail.username,
        text: e.detail.text,
        timestamp: e.detail.timestamp,
        isLocal: false,
      });
    });

    webrtcManager.addEventListener('file-incoming', (e) => {
      ensureTransferRow(e.detail.transferId, {
        name: e.detail.name,
        size: e.detail.size,
        direction: 'receive',
        peerId: e.detail.peerId,
      });
    });

    webrtcManager.addEventListener('file-progress', (e) => {
      updateTransferRow(e.detail);
    });

    webrtcManager.addEventListener('file-complete', (e) => {
      completeTransferRow(e.detail.transferId);
      if (e.detail.folderPath) {
        addToFolderBucket(e.detail);
      } else {
        addReceivedFile(e.detail);
      }
      toast(`Received "${e.detail.name}"`, 'success');
    });
  }

  // ---- Room code / QR -----------------------------------------------------
  function renderRoomCode(code) {
    if (el.roomCode) el.roomCode.textContent = code;
  }

  function renderQrCode(code) {
    if (!el.qr || typeof QRCode === 'undefined') return;
    el.qr.innerHTML = '';
    const roomUrl = `${window.location.origin}/room.html?action=join&code=${encodeURIComponent(code)}`;
    // eslint-disable-next-line no-new
    new QRCode(el.qr, {
      text: roomUrl,
      width: 176,
      height: 176,
      colorDark: '#0b0e1a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  if (el.copyBtn) {
    el.copyBtn.addEventListener('click', async () => {
      if (!roomCode) return;
      try {
        await navigator.clipboard.writeText(roomCode);
        toast('Room code copied', 'success');
      } catch (err) {
        toast('Could not copy — copy it manually.', 'error');
      }
    });
  }

  if (el.qrDownload) {
    el.qrDownload.addEventListener('click', () => {
      const canvas = el.qr && el.qr.querySelector('canvas');
      if (!canvas) return toast('QR code not ready yet.', 'error');
      const link = document.createElement('a');
      link.download = `droplink-${roomCode}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  }

  // ---- User list ------------------------------------------------------
  function renderUserList() {
    if (!el.userList) return;
    el.userList.innerHTML = '';

    roomMembers.forEach((name, userId) => {
      const isSelf = userId === localUserId;
      const state = isSelf ? 'connected' : peerConnState.get(userId) || 'connecting';

      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <span class="user-item__dot user-item__dot--${state}"></span>
        <span class="user-item__name">${escapeHtml(name)}</span>
      `;
      el.userList.appendChild(li);
    });

    if (el.userCount) el.userCount.textContent = String(roomMembers.size);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- File sending: drag & drop + pickers -------------------------------
  function sendFiles(fileList) {
    if (!webrtcManager || webrtcManager.getConnectedCount() === 0) {
      toast('No one is connected yet — share the room code first.', 'error');
      return;
    }
    Array.from(fileList).forEach((file) => {
      // Folder drag-and-drop: the browser sets webkitRelativePath on files
      // dropped from a folder (or picked via the folder input), so folder
      // reconstruction works identically for drag-drop and the picker.
      const relPath = file.webkitRelativePath || null;
      const transferId = webrtcManager.sendFileToAll(file, relPath);
      ensureTransferRow(transferId, { name: relPath || file.name, size: file.size, direction: 'send' });
    });
  }

  function sendFolder(fileList) {
    if (!webrtcManager || webrtcManager.getConnectedCount() === 0) {
      toast('No one is connected yet — share the room code first.', 'error');
      return;
    }
    Array.from(fileList).forEach((file) => {
      const relPath = file.webkitRelativePath || file.name;
      const transferId = webrtcManager.sendFileToAll(file, relPath);
      ensureTransferRow(transferId, { name: relPath, size: file.size, direction: 'send' });
    });
  }

  if (el.fileInput) {
    el.fileInput.addEventListener('change', (e) => {
      sendFiles(e.target.files);
      e.target.value = '';
    });
  }

  if (el.folderInput) {
    el.folderInput.addEventListener('change', (e) => {
      sendFolder(e.target.files);
      e.target.value = '';
    });
  }

  if (el.dropZone) {
    ['dragenter', 'dragover'].forEach((evt) =>
      el.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        el.dropZone.classList.add('is-dragging');
      })
    );
    ['dragleave', 'drop'].forEach((evt) =>
      el.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        el.dropZone.classList.remove('is-dragging');
      })
    );
    el.dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
    });
    el.dropZone.addEventListener('click', () => el.fileInput && el.fileInput.click());
  }

  // ---- Transfer progress UI ---------------------------------------------
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatSpeed(bps) {
    return `${formatBytes(bps)}/s`;
  }

  function ensureTransferRow(transferId, { name, size, direction }) {
    if (!el.transferList) return;
    if (document.getElementById(`transfer-${transferId}`)) return;

    const row = document.createElement('div');
    row.className = 'transfer-row';
    row.id = `transfer-${transferId}`;
    row.innerHTML = `
      <div class="transfer-row__info">
        <span class="transfer-row__icon">${direction === 'send' ? '↑' : '↓'}</span>
        <span class="transfer-row__name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="transfer-row__stats">${formatBytes(size)}</span>
      </div>
      <div class="transfer-row__bar"><div class="transfer-row__fill" style="width:0%"></div></div>
      <div class="transfer-row__meta">
        <span class="transfer-row__percent">0%</span>
        <span class="transfer-row__speed"></span>
      </div>
    `;
    el.transferList.prepend(row);
  }

  function updateTransferRow(detail) {
    const row = document.getElementById(`transfer-${detail.transferId}`);
    if (!row) return;
    const pct = detail.totalBytes ? Math.min(100, Math.round((detail.bytesTransferred / detail.totalBytes) * 100)) : 0;
    row.querySelector('.transfer-row__fill').style.width = `${pct}%`;
    row.querySelector('.transfer-row__percent').textContent = `${pct}%`;
    row.querySelector('.transfer-row__speed').textContent = formatSpeed(detail.speedBps);
  }

  function completeTransferRow(transferId) {
    const row = document.getElementById(`transfer-${transferId}`);
    if (!row) return;
    row.classList.add('transfer-row--done');
    row.querySelector('.transfer-row__percent').textContent = 'Done';
  }

  // ---- Received files -----------------------------------------------------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function addReceivedFile({ name, blob, size }) {
    if (!el.receivedList) return;
    const item = document.createElement('div');
    item.className = 'received-item';
    item.innerHTML = `
      <span class="received-item__name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="received-item__size">${formatBytes(size)}</span>
      <button type="button" class="btn btn--ghost btn--small">Download</button>
    `;
    item.querySelector('button').addEventListener('click', () => downloadBlob(blob, name));
    el.receivedList.prepend(item);
  }

  function addToFolderBucket({ peerId, folderPath, blob, name }) {
    if (!el.receivedList) return;
    const topFolder = folderPath.split('/')[0];
    const key = `${peerId}::${topFolder}`;
    const innerPath = folderPath.split('/').slice(1).join('/') || name;

    let bucket = folderBuckets.get(key);
    if (!bucket) {
      const item = document.createElement('div');
      item.className = 'received-item received-item--folder';
      item.innerHTML = `
        <span class="received-item__name">📁 ${escapeHtml(topFolder)}</span>
        <span class="received-item__size folder-count">1 file</span>
        <button type="button" class="btn btn--ghost btn--small">Download .zip</button>
      `;
      const files = new Map();
      const countEl = item.querySelector('.folder-count');
      item.querySelector('button').addEventListener('click', async () => {
        if (typeof JSZip === 'undefined') return toast('Zip library unavailable.', 'error');
        const zip = new JSZip();
        const folder = zip.folder(topFolder);
        files.forEach((fileBlob, relPath) => folder.file(relPath, fileBlob));
        const content = await zip.generateAsync({ type: 'blob' });
        downloadBlob(content, `${topFolder}.zip`);
      });
      el.receivedList.prepend(item);
      bucket = { files, countEl };
      folderBuckets.set(key, bucket);
    }

    bucket.files.set(innerPath, blob);
    bucket.countEl.textContent = `${bucket.files.size} file${bucket.files.size === 1 ? '' : 's'}`;
  }

  // ---- Chat ---------------------------------------------------------------
  if (el.chatForm) {
    el.chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = el.chatInput.value.trim();
      if (!text || !webrtcManager) return;

      const { timestamp } = await webrtcManager.sendChat(text);
      window.DropLinkChat.renderMessage(el.chatMessages, { username: `${username} (you)`, text, timestamp, isLocal: true });
      el.chatInput.value = '';
    });
  }

  // ---- Leaving --------------------------------------------------------
  if (el.leaveBtn) {
    el.leaveBtn.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  window.addEventListener('beforeunload', () => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leave-room' }));
      }
      if (webrtcManager) webrtcManager.closeAll();
    } catch (err) {
      /* best effort */
    }
  });
})();
