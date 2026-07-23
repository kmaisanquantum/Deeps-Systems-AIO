// =====================================================================
// public/sw.js — Service Worker for Deeps Systems AIO
// =====================================================================

const CACHE_NAME = 'deeps-aio-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html'
];

// On Install: Pre-cache the app shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => {
        return self.skipWaiting();
      })
  );
});

// On Activate: Clean up old caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// On Fetch:
// 1. Bypass cache entirely for any request that:
//    - Starts with '/api/' (authenticated, tenant-specific API calls)
//    - Is cross-origin (e.g. Tailwind CDN, Google Fonts, etc.)
// 2. Use Network-First-then-Cache strategy for navigation/index.html requests.
// 3. Use Cache-First strategy for static local assets like icons/manifest.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Bypass check
  const isApiRequest = url.pathname.startsWith('/api/');
  const isCrossOrigin = url.origin !== self.location.origin;

  if (isApiRequest || isCrossOrigin) {
    // Let those requests go straight to the network without caching
    return;
  }

  // 2. Cache-First for local static assets (icons, manifest)
  const isStaticAsset = url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. Network-First-then-Cache for other local requests (such as / and /index.html)
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Cache successful responses for future offline use
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Offline fallback
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // If the navigation request fails and is not in cache, fallback to index.html if possible
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
  );
});
