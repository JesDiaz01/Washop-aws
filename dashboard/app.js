/**
 * WashOps operations dashboard. Plain browser JavaScript, no build step.
 *
 * Sign-in: OAuth 2.0 authorization code flow with PKCE against Cognito's hosted page. Tokens live
 * in sessionStorage (gone when the tab closes) and are sent to the API as a Bearer token; API
 * Gateway verifies them before any Lambda runs.
 *
 * Every value from the API is written with textContent, never innerHTML: event fields come from
 * site controllers and must never be interpreted as markup.
 */

const SCOPES = 'openid email washops/events.read';
const REFRESH_MS = 30_000;
const TOKENS_KEY = 'washops.tokens';
const PKCE_KEY = 'washops.pkce';

const $ = (id) => document.getElementById(id);
const redirectUri = `${window.location.origin}/`;

let config;
let selectedSite;
let refreshTimer;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const randomString = (byteLength) => base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

async function signIn() {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const url = new URL('/oauth2/authorize', config.authDomain);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(url);
}

/** Back from the hosted sign-in page with ?code=...: exchange the code for tokens. */
async function completeSignIn(params) {
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null');
  sessionStorage.removeItem(PKCE_KEY);
  window.history.replaceState(null, '', redirectUri); // drop the one-time code from the address bar

  if (params.get('error')) {
    throw new Error(`Sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
  }
  if (!saved || saved.state !== params.get('state')) {
    throw new Error('That sign-in response did not come from this browser tab. Please sign in again.');
  }

  const response = await fetch(new URL('/oauth2/token', config.authDomain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: params.get('code'),
      redirect_uri: redirectUri,
      code_verifier: saved.verifier,
    }),
  });
  if (!response.ok) throw new Error(`Sign-in failed (${response.status}). Please try again.`);

  const tokens = await response.json();
  sessionStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    }),
  );
}

function currentTokens() {
  const tokens = JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? 'null');
  if (!tokens || tokens.expiresAt - 30_000 < Date.now()) return undefined;
  return tokens;
}

/** For display only; the API never trusts anything the browser decodes. */
function emailFrom(idToken) {
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).email ?? '';
  } catch {
    return '';
  }
}

function signOut() {
  sessionStorage.removeItem(TOKENS_KEY);
  const url = new URL('/logout', config.authDomain);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri });
  window.location.assign(url);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class SignedOutError extends Error {}

async function api(path) {
  const tokens = currentTokens();
  if (!tokens) throw new SignedOutError();

  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (response.status === 401) {
    sessionStorage.removeItem(TOKENS_KEY);
    throw new SignedOutError();
  }
  if (!response.ok) throw new Error(`The API returned ${response.status} for ${path}.`);
  return response.json();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const count = new Intl.NumberFormat('en-US');
const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Matches the server's 5-minute tolerance (src/domain/clock.ts). */
const CLOCK_TOLERANCE_SECONDS = 300;

function clockSkewLabel(skewSeconds) {
  const seconds = Math.abs(skewSeconds);
  const amount =
    seconds < 3_600 ? `${Math.round(seconds / 60)} min` : seconds < 172_800 ? `${Math.round(seconds / 3_600)} h` : `${Math.round(seconds / 86_400)} days`;
  return `Clock ${amount} ${skewSeconds > 0 ? 'ahead' : 'behind'}`;
}

function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Rendering (DOM nodes + textContent only)
// ---------------------------------------------------------------------------

function el(tag, { className, text, title } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (title) node.title = title;
  node.append(...children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  check: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M5 8.2 7 10.2 11 6'],
  cross: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8'],
  alert: ['M8 1.8 15 14H1L8 1.8Z', 'M8 6.5v3.2M8 11.6v.1'],
  dash: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M5 8h6'],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

const CONNECTIVITY = {
  ONLINE: { status: 'good', icon: 'check', label: 'Online' },
  OFFLINE: { status: 'critical', icon: 'cross', label: 'Offline' },
  UNKNOWN: { status: 'none', icon: 'dash', label: 'No heartbeat yet' },
};

const SEVERITY = {
  LOW: { status: 'none', icon: 'dash', label: 'Low' },
  MEDIUM: { status: 'warning', icon: 'alert', label: 'Medium' },
  HIGH: { status: 'serious', icon: 'alert', label: 'High' },
  CRITICAL: { status: 'critical', icon: 'alert', label: 'Critical' },
};

function statusBadge({ status, icon: iconName, label }) {
  return el('span', { className: `status status-${status}` }, [icon(iconName), el('span', { text: label })]);
}

function tile(label, value, note) {
  return el('div', { className: 'tile' }, [
    el('div', { className: 'tile-label', text: label }),
    el('div', { className: 'tile-value', text: value }),
    ...(note ? [el('div', { className: 'tile-note' }, note)] : []),
  ]);
}

function renderKpis(locations) {
  const sum = (field) => locations.reduce((total, location) => total + location[field], 0);
  const offline = locations.filter((location) => location.connectivity === 'OFFLINE').length;
  const offlineNote = offline
    ? [statusBadge({ ...CONNECTIVITY.OFFLINE, label: 'Needs attention' })]
    : [statusBadge({ ...CONNECTIVITY.ONLINE, label: 'All sites reporting' })];

  $('kpis').replaceChildren(
    tile('Sites', count.format(locations.length)),
    tile('Offline now', count.format(offline), locations.length ? offlineNote : undefined),
    tile('Completed washes', compactCount.format(sum('completedWashes'))),
    tile('Wash revenue', compactMoney.format(sum('totalRevenue'))),
    tile('Equipment faults', compactCount.format(sum('equipmentFaults'))),
  );
}

function renderSites(locations) {
  $('no-sites').hidden = locations.length > 0;
  $('site-rows').replaceChildren(
    ...locations.map((location) => {
      const siteButton = el('button', { className: 'site-link', text: location.locationId });
      siteButton.type = 'button';
      siteButton.addEventListener('click', () => selectSite(location.locationId));

      const row = el('tr', {}, [
        el('td', {}, [siteButton]),
        el('td', {}, [statusBadge(CONNECTIVITY[location.connectivity] ?? CONNECTIVITY.UNKNOWN)]),
        el('td', { className: 'num', text: count.format(location.completedWashes) }),
        el('td', { className: 'num', text: money.format(location.totalRevenue) }),
        el('td', { className: 'num', text: count.format(location.paymentsCompleted) }),
        el('td', { className: 'num', text: count.format(location.equipmentFaults) }),
        el('td', { className: 'nowrap' }, [
          el('span', {
            text: location.lastHeartbeat ? timeAgo(location.lastHeartbeat) : 'Never',
            title: location.lastHeartbeat ? dateTime.format(new Date(location.lastHeartbeat)) : undefined,
          }),
          ...(Math.abs(location.controllerClockSkewSeconds ?? 0) > CLOCK_TOLERANCE_SECONDS
            ? [
                el('span', { className: 'detail-note' }, [
                  statusBadge({ status: 'warning', icon: 'alert', label: clockSkewLabel(location.controllerClockSkewSeconds) }),
                ]),
              ]
            : []),
        ]),
      ]);
      if (location.locationId === selectedSite) row.className = 'selected';
      return row;
    }),
  );
}

function describeEvent(event) {
  const { data } = event;
  switch (event.eventType) {
    case 'WASH_STARTED':
      return { label: 'Wash started', details: [`${data.washPackage}${data.bayId ? ` in ${data.bayId}` : ''}`] };
    case 'WASH_COMPLETED':
      return {
        label: 'Wash completed',
        details: [`${data.washPackage}, ${money.format(data.amount)}, ${duration(data.durationSeconds)}`],
      };
    case 'PAYMENT_COMPLETED':
      return { label: 'Payment', details: [`${money.format(data.amount)} by ${data.paymentMethod.toLowerCase()}`] };
    case 'EQUIPMENT_FAULT':
      return {
        label: 'Equipment fault',
        details: [
          el('span', { className: 'detail-line' }, [
            statusBadge(SEVERITY[data.severity] ?? SEVERITY.LOW),
            el('span', { text: `${data.faultCode} on ${data.equipmentId}` }),
          ]),
          ...(data.message ? [el('span', { className: 'detail-note', text: data.message })] : []),
        ],
      };
    default:
      return { label: event.eventType, details: [] };
  }
}

function renderActivity(locationId, events) {
  $('activity').hidden = false;
  $('activity-title').textContent = `Recent activity at ${locationId}`;
  $('no-activity').hidden = events.length > 0;
  $('activity-rows').replaceChildren(
    ...events.map((event) => {
      const { label, details } = describeEvent(event);
      return el('tr', {}, [
        el('td', { className: 'nowrap', text: timeAgo(event.occurredAt), title: dateTime.format(new Date(event.occurredAt)) }),
        el('td', { className: 'nowrap', text: label }),
        el('td', {}, details),
      ]);
    }),
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function showSignedOut() {
  clearInterval(refreshTimer);
  $('session').hidden = true;
  $('signed-in').hidden = true;
  $('signed-out').hidden = false;
}

async function refresh() {
  try {
    const { locations } = await api('/locations');
    renderKpis(locations);
    renderSites(locations);
    if (selectedSite) {
      const { events } = await api(`/locations/${encodeURIComponent(selectedSite)}/events?limit=20`);
      renderActivity(selectedSite, events);
    }
    $('updated').textContent = `Updated ${clock.format(new Date())}`;
    showError('');
  } catch (error) {
    if (error instanceof SignedOutError) return showSignedOut();
    showError(`${error.message} Retrying in 30 seconds.`);
  }
}

function selectSite(locationId) {
  selectedSite = locationId;
  refresh();
}

function showSignedIn(tokens) {
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('session').hidden = false;
  $('user-email').textContent = emailFrom(tokens.idToken);
  refresh();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
}

async function start() {
  $('sign-in').addEventListener('click', () => signIn().catch((error) => showError(error.message)));
  $('sign-out').addEventListener('click', signOut);
  $('refresh').addEventListener('click', refresh);
  $('close-activity').addEventListener('click', () => {
    selectedSite = undefined;
    $('activity').hidden = true;
    refresh();
  });

  try {
    const response = await fetch('config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    config = await response.json();
  } catch {
    showError('This dashboard is not configured yet: run scripts/publish-dashboard.mjs to upload config.json.');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.has('code') || params.has('error')) {
    try {
      await completeSignIn(params);
    } catch (error) {
      showError(error.message);
    }
  }

  const tokens = currentTokens();
  if (tokens) {
    showSignedIn(tokens);
  } else {
    showSignedOut();
  }
}

start();
