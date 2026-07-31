/**
 * app.js
 * ------
 * Logic for the landing page (index.html) only. Its whole job is to
 * collect a username + intent (create or join) and hand off to
 * room.html, which owns the actual WebSocket connection and room
 * lifecycle. Keeping the socket handshake on one page avoids the mess
 * of trying to carry a live WebSocket across a navigation.
 */

(function () {
  const USERNAME_KEY = 'droplink:username';
  const THEME_KEY = 'droplink:theme';

  function generateGuestName() {
    return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  function getStoredUsername() {
    return localStorage.getItem(USERNAME_KEY) || '';
  }

  function storeUsername(name) {
    if (name) localStorage.setItem(USERNAME_KEY, name);
  }

  function applyStoredTheme() {
    const theme = localStorage.getItem(THEME_KEY) || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    return theme;
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  }

  function resolveUsername(inputEl) {
    const typed = inputEl && inputEl.value.trim();
    const name = typed || getStoredUsername() || generateGuestName();
    storeUsername(name);
    return name;
  }

  function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('is-visible', Boolean(message));
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyStoredTheme();

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

    const usernameInput = document.getElementById('usernameInput');
    if (usernameInput) usernameInput.value = getStoredUsername();

    const createBtn = document.getElementById('createRoomBtn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        const username = resolveUsername(usernameInput);
        window.location.href = `room.html?action=create&username=${encodeURIComponent(username)}`;
      });
    }

    const joinForm = document.getElementById('joinRoomForm');
    const joinCodeInput = document.getElementById('joinCodeInput');
    const joinError = document.getElementById('joinError');
    const joinModal = document.getElementById('joinModal');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const joinModalClose = document.getElementById('joinModalClose');

    if (joinRoomBtn && joinModal) {
      joinRoomBtn.addEventListener('click', () => {
        joinModal.classList.add('is-open');
        if (joinCodeInput) joinCodeInput.focus();
      });
    }
    if (joinModalClose && joinModal) {
      joinModalClose.addEventListener('click', () => joinModal.classList.remove('is-open'));
    }
    if (joinModal) {
      joinModal.addEventListener('click', (e) => {
        if (e.target === joinModal) joinModal.classList.remove('is-open');
      });
    }

    if (joinForm) {
      joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = (joinCodeInput.value || '').trim().toUpperCase();
        const normalized = raw.startsWith('DL-') ? raw : `DL-${raw}`;

        if (!/^DL-[A-Z0-9]{5}$/.test(normalized)) {
          showError(joinError, 'Room codes look like DL-82X91.');
          return;
        }

        showError(joinError, '');
        const username = resolveUsername(usernameInput);
        window.location.href = `room.html?action=join&code=${encodeURIComponent(normalized)}&username=${encodeURIComponent(username)}`;
      });
    }
  });
})();
