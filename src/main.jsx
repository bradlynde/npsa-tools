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

window.addEventListener('message', (e) => {
  // Only the framing shell may restyle this app.
  if (framed && e.source !== window.parent) return;
  const data = e.data;
  if (!data || data.type !== 'npsa:theme') return;
  applyTheme(data.mode);
});

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
