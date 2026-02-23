/* ═══════════════════════════════════════════════════════════════
   ATHStudios Admin Console — Service Worker  v2
   ─────────────────────────────────────────────────────────────
   Push strategy (no FCM, no server):
   • Tab OPEN / HIDDEN  → Firebase live listener fires → app posts
                          message to SW → SW shows notification
   • Tab CLOSED         → Periodic Background Sync wakes the SW
                          → SW fetches Firebase REST API directly
                          → compares against last-seen IDs in IDB
                          → shows notification for every new inquiry
   ─────────────────────────────────────────────────────────────
   Caching strategy:
   • App Shell   → Cache-first
   • CDN assets  → Stale-while-revalidate
   • Firebase    → Network-only (SDK manages its own offline queue)
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME       = 'ath-admin-v2';
const SYNC_TAG         = 'ath-firebase-sync';
const PERIODIC_TAG     = 'ath-inquiry-check';
const DB_NAME          = 'ath-sw-db';
const DB_VERSION       = 2;

/* ─── App shell to pre-cache ─── */
const SHELL_ASSETS = ['./index.html'];

/* ─── CDN origins — stale-while-revalidate ─── */
const CACHE_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
];

/* ─── Firebase origins — always network ─── */
const FIREBASE_ORIGINS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com/firebasejs',
];

/* ══════════════════════════════════════════════
   INDEXED DB  — single open, three stores
     config  : firebase URL + apiKey + lastCheckedTs
     seenIds : set of inquiry IDs already notified
     queue   : offline write queue
══════════════════════════════════════════════ */
let _idb = null;

function openIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('config'))
        db.createObjectStore('config', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('seenIds'))
        db.createObjectStore('seenIds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('queue'))
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbGet(store, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/* ══════════════════════════════════════════════
   INSTALL
══════════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ══════════════════════════════════════════════
   ACTIVATE
══════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ══════════════════════════════════════════════
   FETCH  — routing
══════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (FIREBASE_ORIGINS.some(o => url.hostname.includes(o))) return;
  if (!url.protocol.startsWith('http')) return;

  if (CACHE_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(r => {
    if (r.ok) cache.put(request, r.clone());
    return r;
  }).catch(() => cached);
  return cached || fetchPromise;
}

/* ══════════════════════════════════════════════
   MESSAGES  — from the app page
══════════════════════════════════════════════ */
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  /* ── Store Firebase config so SW can call REST API ── */
  if (type === 'FIREBASE_CONFIG') {
    await idbPut('config', { key: 'firebaseConfig', ...payload });
    return;
  }

  /* ── App detected a new inquiry while tab is open/hidden ── */
  if (type === 'NEW_INQUIRY') {
    const { id, name, projectType, budget } = payload;

    /* Mark as seen so periodic check doesn't double-notify */
    await idbPut('seenIds', { id, ts: Date.now() });

    /* Show the notification */
    await showInquiryNotification({ id, name, projectType, budget });
    return;
  }

  /* ── Queue an offline Firebase write ── */
  if (type === 'QUEUE_FIREBASE_OP') {
    await idbPut('queue', { payload, ts: Date.now() });
    if ('sync' in self.registration) {
      await self.registration.sync.register(SYNC_TAG);
    }
    return;
  }

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ══════════════════════════════════════════════
   SHOW NOTIFICATION  — shared helper
══════════════════════════════════════════════ */
async function showInquiryNotification({ id, name, projectType, budget }) {
  const title = '📬 New Inquiry — ATHStudios';
  const body  = [
    name        ? `From: ${name}`          : null,
    projectType ? `Project: ${projectType}` : null,
    budget      ? `Budget: ${budget}`       : null,
  ].filter(Boolean).join('\n') || 'A new inquiry has arrived.';

  return self.registration.showNotification(title, {
    body,
    icon   : './icons/icon.svg',
    badge  : './icons/icon.svg',
    tag    : `inquiry-${id}`,          // collapses duplicate notifications
    renotify: false,
    vibrate: [200, 100, 200],
    data   : { id, url: './index.html' },
    actions: [
      { action: 'view',    title: 'View Inquiry' },
      { action: 'dismiss', title: 'Dismiss'      },
    ],
  });
}

/* ══════════════════════════════════════════════
   NOTIFICATION CLICK
══════════════════════════════════════════════ */
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  /* Focus existing tab or open new one */
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes('index.html'));
        if (existing) {
          existing.focus();
          /* Tell the tab to open the drawer for this inquiry */
          existing.postMessage({
            type: 'OPEN_INQUIRY',
            id  : event.notification.data?.id,
          });
          return;
        }
        return self.clients.openWindow('./index.html');
      })
  );
});

/* ══════════════════════════════════════════════
   PERIODIC BACKGROUND SYNC
   Fires even when every tab is closed.
   Chrome respects minInterval but may delay more
   depending on site engagement score.
══════════════════════════════════════════════ */
self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_TAG) {
    event.waitUntil(checkForNewInquiries());
  }
});

async function checkForNewInquiries() {
  /* Load Firebase config stored by the app */
  const cfg = await idbGet('config', 'firebaseConfig');
  if (!cfg?.databaseURL) return; // not configured yet

  /* Load last check timestamp */
  const lastRec = await idbGet('config', 'lastCheckedTs');
  const lastTs  = lastRec?.value || (Date.now() - 24 * 60 * 60 * 1000); // default: last 24h

  /* Fetch inquiries from Firebase REST API */
  let inquiries;
  try {
    const url = `${cfg.databaseURL}/inquiries.json?auth=${cfg.apiKey}`;
    const res  = await fetch(url);
    if (!res.ok) return;
    const raw = await res.json();
    if (!raw) return;
    inquiries = Object.entries(raw).map(([id, v]) => ({ id, ...v }));
  } catch {
    return;
  }

  /* Load already-seen IDs */
  const seenRecs = await idbGetAll('seenIds');
  const seenSet  = new Set(seenRecs.map(r => r.id));

  /* Find genuinely new inquiries */
  const brand_new = inquiries.filter(inq =>
    !seenSet.has(inq.id) &&
    (inq.status === 'new' || !inq.status) &&
    (inq.submittedAt || 0) > lastTs
  );

  /* Fire a notification for each new inquiry */
  for (const inq of brand_new) {
    const typeStr = Array.isArray(inq.projectTypes) && inq.projectTypes.length
      ? inq.projectTypes.join(', ')
      : inq.projectType || null;

    await showInquiryNotification({
      id         : inq.id,
      name       : inq.fullName    || null,
      projectType: typeStr,
      budget     : inq.budget      || null,
    });

    /* Mark as seen */
    await idbPut('seenIds', { id: inq.id, ts: Date.now() });
  }

  /* Update last check timestamp */
  await idbPut('config', { key: 'lastCheckedTs', value: Date.now() });

  /* Prune seenIds older than 30 days so IDB doesn't grow forever */
  const cutoff   = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stale    = seenRecs.filter(r => r.ts < cutoff);
  for (const r of stale) await idbDelete('seenIds', r.id);
}

/* ══════════════════════════════════════════════
   BACKGROUND SYNC  — offline write flush
══════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushQueue());
});

async function flushQueue() {
  const items = await idbGetAll('queue');
  if (!items.length) return;

  const results = await Promise.allSettled(
    items.map(async item => {
      const { method, url, body } = item.payload;
      const res = await fetch(url, {
        method : method || 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await idbDelete('queue', item.id);
    })
  );

  const clients = await self.clients.matchAll({ type: 'window' });
  const synced  = results.filter(r => r.status === 'fulfilled').length;
  const failed  = results.filter(r => r.status === 'rejected').length;
  clients.forEach(c => c.postMessage({ type: 'SYNC_COMPLETE', synced, failed }));
}
