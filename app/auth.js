/* Optional account sync: login/signup against the progress API, falling back
   to local-only (localStorage) mode if no account or the API is unreachable. */

const API_BASE = window.ECON_API_BASE || "";
const TOKEN_KEY = "econ-auth-token";
const EMAIL_KEY = "econ-auth-email";
const STATE_KEY = "econ-adaptive-state-v1";
let syncTimer = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: "Bearer " + getToken() } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function scheduleSync() {
  if (!getToken() || !API_BASE) return;
  clearTimeout(syncTimer);
  setSyncBadge("saving…");
  syncTimer = setTimeout(async () => {
    try {
      const state = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
      await apiFetch("/api/progress", {
        method: "PUT",
        body: JSON.stringify({ state }),
      });
      setSyncBadge("synced");
    } catch {
      setSyncBadge("offline — saved locally only");
    }
  }, 1200);
}

function wrapSaveState() {
  const original = window.saveState;
  window.saveState = function (...args) {
    original.apply(this, args);
    scheduleSync();
  };
}

function setSyncBadge(text) {
  const badge = document.getElementById("account-badge-status");
  if (badge) badge.textContent = text;
}

function renderAccountBadge() {
  const email = localStorage.getItem(EMAIL_KEY);
  const existing = document.getElementById("account-badge");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "account-badge";
  el.className = "account-badge";
  if (email) {
    el.innerHTML = `
      <span>${email}</span>
      <span id="account-badge-status" class="account-badge-status">synced</span>
      <button id="account-logout" type="button">Log out</button>
    `;
  } else {
    el.innerHTML = `
      <span class="account-badge-status">Progress saved on this device only</span>
      <button id="account-signin" type="button">Sign in</button>
    `;
  }
  document.body.appendChild(el);
  const logoutBtn = document.getElementById("account-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
  const signinBtn = document.getElementById("account-signin");
  if (signinBtn) signinBtn.addEventListener("click", () => showGate({ dismissable: true }));
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
  renderAccountBadge();
}

function showGate({ dismissable }) {
  const overlay = document.createElement("div");
  overlay.className = "auth-overlay";
  overlay.innerHTML = `
    <div class="auth-card">
      <h2>Sign in to sync your progress</h2>
      <p class="auth-sub">Keep your streak and mastery on every device. Optional — you can skip and keep progress on this device only.</p>
      <form id="auth-form">
        <input id="auth-email" type="email" placeholder="Email" autocomplete="email" required />
        <input id="auth-password" type="password" placeholder="Password (min 8 characters)" autocomplete="current-password" minlength="8" required />
        <div class="auth-error" id="auth-error"></div>
        <div class="auth-actions">
          <button type="submit" id="auth-login-btn">Log in</button>
          <button type="button" id="auth-signup-btn">Sign up</button>
        </div>
      </form>
      ${dismissable ? '<button type="button" id="auth-skip" class="auth-skip">Continue without an account</button>' : '<button type="button" id="auth-skip" class="auth-skip">Skip for now</button>'}
    </div>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#auth-form");
  const errorEl = overlay.querySelector("#auth-error");
  const emailEl = overlay.querySelector("#auth-email");
  const passwordEl = overlay.querySelector("#auth-password");

  async function submit(path) {
    errorEl.textContent = "";
    try {
      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ email: emailEl.value, password: passwordEl.value }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(EMAIL_KEY, emailEl.value.trim().toLowerCase());
      await pullRemoteState();
      overlay.remove();
      boot();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit("/api/login");
  });
  overlay.querySelector("#auth-signup-btn").addEventListener("click", () => submit("/api/signup"));
  overlay.querySelector("#auth-skip").addEventListener("click", () => {
    overlay.remove();
    if (dismissable) return;
    boot();
  });
}

async function pullRemoteState() {
  try {
    const { state } = await apiFetch("/api/progress");
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // offline or server unreachable — fall back to whatever is stored locally
  }
}

function boot() {
  wrapSaveState();
  window.loadState();
  window.render();
  renderAccountBadge();
}

window.startApp = async function startApp() {
  if (!API_BASE) {
    // No backend configured yet — behave exactly like the local-only version.
    window.loadState();
    window.render();
    return;
  }
  if (getToken()) {
    await pullRemoteState();
    boot();
  } else {
    showGate({ dismissable: false });
  }
};
