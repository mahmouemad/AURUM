'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// AURUM Fitness — Service Worker
// Bump CACHE_VERSION to "v2", "v3", etc. whenever you ship a new release.
// That triggers the activate handler to wipe the old cache automatically.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v1';
const CACHE_NAME    = `aurum-shell-${CACHE_VERSION}`;

/**
 * App Shell — the minimum set of files needed to render the UI offline.
 * Every path here must exist on the server, or the entire install event fails.
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];


// ─── INSTALL ─────────────────────────────────────────────────────────────────
// Fires once when this SW version is first seen by the browser.
// Goal: pre-cache the shell so the NEXT load can be served fully offline.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log(`[AURUM SW] Installing → ${CACHE_NAME}`);

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log('[AURUM SW] Pre-caching shell assets…');
        // cache.addAll() is atomic — one 404 aborts the whole install.
        // Make sure every entry in SHELL_ASSETS resolves on your server.
        return cache.addAll(SHELL_ASSETS);
      })
      .then(() => {
        // Skip the default "waiting" phase.
        // This SW becomes active immediately even if the old one is still running.
        console.log('[AURUM SW] Shell cached. Skipping wait…');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[AURUM SW] Install failed — check SHELL_ASSETS paths:', err);
      })
  );
});


// ─── ACTIVATE ────────────────────────────────────────────────────────────────
// Fires after install, once no old SW is controlling any clients.
// Goal: delete every stale "aurum-*" cache from previous versions.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log(`[AURUM SW] Activating → ${CACHE_NAME}`);

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (name) =>
                // Target only our own caches; leave third-party caches alone.
                name.startsWith('aurum-') && name !== CACHE_NAME
            )
            .map((staleName) => {
              console.log(`[AURUM SW] Purging stale cache: ${staleName}`);
              return caches.delete(staleName);
            })
        )
      )
      .then(() => {
        // Take immediate control of all open tabs without requiring a reload.
        console.log('[AURUM SW] Now controlling all clients.');
        return self.clients.claim();
      })
  );
});


// ─── FETCH ───────────────────────────────────────────────────────────────────
// Intercepts every network request the app makes.
//
// Two-tier strategy:
//
//   Shell assets  → Stale-While-Revalidate
//                   Serve from cache instantly (zero latency), then silently
//                   fetch a fresh copy in the background so the *next* load
//                   gets the latest version without ever blocking the user.
//
//   Everything else → Network-First with Cache Fallback
//                     Try the network for fresh data; if offline, serve the
//                     cached version. New successful responses are cached
//                     automatically for future offline use.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Guard rails ────────────────────────────────────────────────────────────
  // Do not intercept non-GET requests (POST, PUT, DELETE, etc.)
  if (request.method !== 'GET') return;

  // Do not intercept cross-origin requests (analytics, CDNs, external APIs).
  // Only handle requests from the same origin as this SW.
  if (url.origin !== self.location.origin) return;

  // ── Classify the request ───────────────────────────────────────────────────
  const isShellRequest =
    url.pathname === '/' ||
    SHELL_ASSETS.some((asset) =>
      url.pathname.endsWith(asset.replace('./', '/'))
    );

  // ── Strategy A: Stale-While-Revalidate (shell assets) ─────────────────────
  if (isShellRequest) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cachedResponse) => {
          // Fire a background network request regardless of cache state.
          const networkFetch = fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                // Silently update the cache entry for next time.
                cache.put(request, networkResponse.clone());
              }
              return networkResponse;
            })
            .catch(() => {
              // We're offline — background update is impossible.
              // The cached response (below) already handles this gracefully.
            });

          // Return the cached version right away if it exists.
          // Otherwise wait for the network (first-ever load).
          return cachedResponse || networkFetch;
        })
      )
    );
    return;
  }

  // ── Strategy B: Network-First with Cache Fallback (dynamic assets) ─────────
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // Cache clean, successful, same-origin responses for offline use.
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === 'basic'
        ) {
          const responseToCache = networkResponse.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, responseToCache));
        }
        return networkResponse;
      })
      .catch(() =>
        // Network failed (offline) — try the cache.
        caches.match(request).then((cachedFallback) => {
          if (cachedFallback) return cachedFallback;

          // For full-page navigations with no cached fallback,
          // return the shell so the app can still render.
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }

          // For sub-resources (images, fonts, etc.) return a minimal stub
          // so the rest of the page can still load.
          return new Response('Service Unavailable — you appear to be offline.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        })
      )
  );
});