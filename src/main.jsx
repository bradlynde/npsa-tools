import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './theme.css';

/*
 * This app is meant to be embedded, not visited.
 *
 * The toolbox shell (npsa-tools) frames it and supplies the nav, the dashboard
 * link and the current styling. Nothing stops anyone opening this origin
 * directly, though — a saved bookmark, a link from before the shell existed, or
 * a mistyped API path falling through to the SPA — and what they get is a second
 * landing page for the same tools, on older styling, with no way back. Two front
 * doors to one set of tools is the confusing part, not the age of this one.
 *
 * So a top-level visit is handed on. Framed use is untouched: the check is
 * whether we are the top window, which is false inside the shell.
 */
const SHELL = import.meta.env.VITE_TOOLBOX_URL || 'https://npsa-tools.vercel.app';

function shellUrlForThisVisit() {
  const view = new URLSearchParams(window.location.search).get('view');
  // The shell opens a tool through /loe?view=; without one, its landing page.
  return view ? `${SHELL}/loe?view=${encodeURIComponent(view)}` : `${SHELL}/toolbox`;
}

const framed = window.self !== window.top;
const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
// An explicit escape hatch, so this origin stays reachable for debugging.
const standalone = new URLSearchParams(window.location.search).has('standalone');

/*
 * Theme, handed down from the shell.
 *
 * The shell frames this app from a different origin, so its localStorage is not
 * readable here — the toggle in its top bar has to be relayed. It posts on mount
 * and on every change; this applies the class the stylesheet keys off, exactly
 * as the shell does to its own <body>.
 *
 * The last value is remembered so a reload inside the frame doesn't flash light
 * before the first message lands. Opened directly, ?theme=dark still works,
 * which is what makes this screenshottable without the shell.
 */
const applyTheme = (mode) => {
  document.body.classList.toggle('dark', mode === 'dark');
  try { localStorage.setItem('npsa-theme', mode === 'dark' ? 'dark' : 'light'); } catch { /* private mode */ }
};

try {
  const forced = new URLSearchParams(window.location.search).get('theme');
  applyTheme(forced || localStorage.getItem('npsa-theme') || 'light');
} catch { /* private mode */ }

/*
 * Login, handed down from the shell.
 *
 * Every /api route on this origin needs a credential (server/api-gate.js). The
 * person already signed in to the shell, and the shell posts their login token in
 * on load and again whenever this frame asks for it. This app keeps it in memory
 * only and adds it to its own /api calls. Calls made before it arrives wait for
 * it briefly, so the first screen doesn't fail on a race with the message.
 *
 * Opened directly (local dev through the Vite proxy, or ?standalone) there is no
 * shell and nothing to wait for; the backend decides what those calls may do.
 */
let authToken = '';
let authArrived;
const authReady = new Promise((resolve) => { authArrived = resolve; });
if (!framed) authArrived();
else setTimeout(authArrived, 5000);

const isOwnApi = (input) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch { return false; }
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  if (!isOwnApi(input)) return originalFetch(input, init);
  await authReady;
  if (!authToken) return originalFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${authToken}`);
  return originalFetch(input, { ...init, headers });
};

window.addEventListener('message', (e) => {
  // Only the framing shell may restyle this app or hand it a login.
  if (framed && e.source !== window.parent) return;
  const data = e.data;
  if (!data) return;
  if (data.type === 'npsa:theme') applyTheme(data.mode);
  if (data.type === 'npsa:auth' && typeof data.token === 'string') {
    authToken = data.token;
    authArrived();
  }
});

// Ask as soon as we exist rather than waiting for the frame's load event, which
// fires after the first screen has already started its requests.
if (framed) window.parent.postMessage({ type: 'npsa:auth-request' }, '*');

if (!framed && !local && !standalone && SHELL) {
  // replace, not assign: the back button should return where they came from,
  // not bounce them through this redirect a second time.
  window.location.replace(shellUrlForThisVisit());
} else {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
