# DropLink

**Share anything. Anywhere. Instantly.**

DropLink is a decentralized, temporary peer-to-peer sharing platform. Files, folders, links, and chat messages move **directly between browsers** over an encrypted WebRTC connection — the server only helps two browsers find each other and never sees, stores, or touches a single byte of your data.

- 🔒 **Zero storage** — nothing is written to disk or a database, ever
- 🤝 **Peer-to-peer** — transfers use WebRTC DataChannels, not an upload/download server
- 🔐 **Encrypted** — every chunk and message is encrypted client-side with AES-256-GCM before it leaves the browser
- ⏳ **Temporary** — rooms exist only in memory and expire automatically
- 🚫 **No accounts, no tracking** — join with a room code or QR, nothing else

---

## Features

| | |
|---|---|
| ✅ Temporary rooms (code + QR) | ✅ Drag-and-drop upload |
| ✅ P2P file transfer, any file type | ✅ Folder sharing with ZIP reconstruction |
| ✅ Transfer progress, size & speed | ✅ Real-time encrypted text chat |
| ✅ Link sharing with title preview | ✅ Dark / light mode |
| ✅ Connected users list | ✅ Connection status indicator |
| ✅ Copy room code / download QR | ✅ Toast notifications |
| ✅ Auto-expiring rooms | ✅ Fully responsive, glassmorphism UI |

---

## Architecture

```
┌────────────┐        WebSocket (signaling only)        ┌────────────┐
│  Browser A │ ───────────────────────────────────────▶ │   Server   │
│            │ ◀─────────────────────────────────────── │ (Express + │
└─────┬──────┘        room codes · SDP · ICE             │   ws)      │
      │                                                  └─────┬──────┘
      │                                                        │
      │            WebRTC DataChannel (direct, encrypted)      │
      └───────────────────────────◀────────────────────────────┘
                     files · folders · chat · links
                     (server is never in this path)
```

- The **server** (`server/`) is a small Express app plus a `ws` WebSocket server. It hands out room codes, tracks who's currently in a room (in memory only), and relays the WebRTC offer/answer/ICE handshake so two browsers can open a DataChannel. Once that channel is open, the server has no further role.
- The **client** (`client/`) is plain HTML/CSS/JS — no framework, no build step. Each browser opens one `RTCPeerConnection` per peer in the room (a mesh), encrypts every chunk with a key derived from the room code, and streams it over the DataChannel with backpressure-aware chunking.

---

## Tech stack

- **Frontend:** HTML5, CSS3 (glassmorphism, CSS variables, no framework), vanilla JavaScript
- **Backend:** Node.js, Express.js
- **Signaling:** WebSocket (`ws`)
- **Transport:** WebRTC `RTCDataChannel`
- **Encryption:** Web Crypto API (AES-256-GCM, PBKDF2 key derivation)
- **QR codes:** [qrcodejs](https://github.com/davidshimjs/qrcodejs) (client-side, CDN)
- **Folder zipping:** [JSZip](https://stuk.github.io/jszip/) (client-side, CDN)

---

## Project structure

```
DropLink/
├── client/
│   ├── index.html          # Landing page
│   ├── room.html            # Room page
│   ├── css/
│   │   └── style.css        # Design system + layout
│   ├── js/
│   │   ├── app.js           # Landing page logic
│   │   ├── room.js          # Room orchestration
│   │   ├── webrtc.js        # RTCPeerConnection mesh + file transfer protocol
│   │   ├── chat.js          # Chat rendering + link previews
│   │   └── crypto.js        # AES-GCM encrypt/decrypt helpers
│   └── assets/
│       ├── logo.svg
│       └── favicon.ico
├── server/
│   ├── server.js             # Express app + WebSocket bootstrap
│   ├── roomManager.js        # In-memory room store + expiration sweep
│   └── signaling.js          # WebSocket message router
├── package.json
├── .gitignore
└── README.md
```

---

## Installation

Requires **Node.js ≥ 18**.

```bash
git clone https://github.com/vincenzo-afk/droplink.git
cd droplink
npm install
```

## Running locally

```bash
npm start
```

Then open **http://localhost:3000**. Open it in a second tab (or send the room code/QR to another device on the same network) to test a real transfer.

For auto-restart on file changes during development:

```bash
npm run dev
```

`PORT` can be overridden via an environment variable, e.g. `PORT=8080 npm start`.

---

## How a room works

1. **Create Room** generates a short code (e.g. `DL-82X91`) and opens a WebSocket connection.
2. Anyone who **joins** with that code (typed, or via QR scan) connects to the same WebSocket "room."
3. The server introduces the new peer to everyone already there; each browser pair then negotiates a direct `RTCPeerConnection` using the server purely as a message relay for the SDP offer/answer and ICE candidates.
4. Once the DataChannel opens, files, folders, and chat travel **directly** between browsers, chunked (16KB) and encrypted (AES-256-GCM) end to end.
5. Rooms are deleted from memory automatically once they've been empty for a couple of minutes, or after 30 minutes of total inactivity — whichever comes first.

> **Note on NAT traversal:** DropLink ships with public STUN servers, which is enough for most home/office networks. Very restrictive NATs or corporate firewalls may need a TURN server added to `ICE_SERVERS` in `client/js/webrtc.js` for a guaranteed connection.

---

## Deployment

### Backend (Render / Railway)

1. Push this repo to GitHub.
2. Create a new Web Service pointing at the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Note the deployed URL (e.g. `https://droplink-server.onrender.com`).

### Frontend (Vercel)

The frontend is fully static, but it needs the WebSocket/API to reach the backend above. The simplest approach is to deploy the whole app as a single Node service (Render/Railway serves both `client/` and the WebSocket from one process — nothing extra to configure). If you'd rather host the static files on Vercel separately, point the client's WebSocket URL at your backend's `wss://` origin instead of `window.location.host` in `client/js/room.js`.

---

## Security notes

- Room-shared AES-256-GCM key, derived via PBKDF2 from the room code — good for keeping a casual sharing session private, not a substitute for authenticated key exchange in a high-security context.
- The server never persists room membership, chat text, or file data; everything lives in a single in-memory `Map` for the life of the process.
- Room codes deliberately exclude visually ambiguous characters (`0`, `O`, `1`, `I`).

---

## Future improvements

- TURN server support for restrictive NAT/firewall environments
- Resumable transfers (survive a dropped connection mid-file)
- Optional password-protected rooms (separate from the room code itself)
- Mobile camera-based QR scanning for joining
- Transfer history export (client-side only, per session)

---

## License

MIT
