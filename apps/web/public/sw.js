/* eslint-env serviceworker */

/**
 * LOVERLINK SERVICE WORKER.
 *
 * WHAT IT IS FOR, IN ORDER OF HOW MUCH IT MATTERS
 * -----------------------------------------------
 *   1. PUSH. A drop-in voice product is worthless if you only find out someone
 *      wanted to talk when you next happen to open the app. This is the only
 *      way a closed tab can be told anything, and it is the reason this file
 *      exists at all.
 *   2. An install. A PWA is not installable without a service worker, and being
 *      on a home screen is what makes "drop in for ten minutes" plausible.
 *   3. A shell that survives a tunnel. Not offline USE — a voice room needs the
 *      network by definition — but the difference between a blank white page
 *      and a screen that says what has happened.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not cache API responses. Every one of them is either personal, live,
 * or both: a cached room list shows rooms that closed an hour ago, and a cached
 * `/me` shows a trust score from before the ban. Serving a stale answer that
 * LOOKS current is worse than an error, because an error is something a person
 * can act on.
 *
 * So: static assets are cached, and nothing else is.
 */

/**
 * Bump this to retire every previously cached asset.
 *
 * The old cache is deleted on activate, so a bad deploy is one version bump
 * away from being gone rather than living in people's browsers indefinitely.
 */
const CACHE = 'loverlink-shell-v1';

/**
 * What to have ready before the network is needed.
 *
 * Deliberately short. Next.js fingerprints its own build output, so listing
 * chunks here would be listing filenames that change every deploy; those are
 * cached on first use by the fetch handler instead.
 */
const SHELL = ['/', '/rooms', '/offline.html', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `addAll` rejects the whole install if ANY entry 404s, which would leave
      // the app with no worker at all. Each is added on its own so one missing
      // asset costs one asset.
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => undefined)),
      );

      // Take over without waiting for every tab to close. Safe because this
      // worker caches only static assets — there is no in-flight state for a
      // new version to disagree with an old one about.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Fetch: cache static assets, never anything personal.
 *
 * The rules, in the order they are applied:
 *
 *   - not a GET            -> straight to the network. A cached POST would be
 *                             an entirely different kind of bug.
 *   - a different origin   -> straight to the network. The API and the media
 *                             server are both cross-origin, and neither has a
 *                             single response worth keeping.
 *   - a navigation         -> network first, falling back to the offline page.
 *                             A room list from twenty minutes ago is a lie;
 *                             a page that says "you are offline" is not.
 *   - anything else        -> cache first. These are fingerprinted build
 *                             artefacts, so a hit is always correct.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match('/offline.html')) ??
            new Response('You are offline.', {
              status: 503,
              headers: { 'content-type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit !== undefined) return hit;

      const response = await fetch(request);

      // Only successful, same-origin, basic responses. Caching an opaque or
      // error response means serving it back forever.
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => undefined);
      }

      return response;
    })(),
  );
});

/**
 * PUSH — the reason this file exists.
 *
 * WHY THE PAYLOAD IS PARSED DEFENSIVELY
 * -------------------------------------
 * A push that throws shows the browser's own "This site has been updated in the
 * background" notification, which is both useless and slightly alarming. Any
 * malformed payload therefore degrades to a real, if vague, message.
 *
 * WHY NOTHING SENSITIVE IS IN THE BODY
 * ------------------------------------
 * A notification is rendered on a LOCKED SCREEN, in a coffee shop, on a bus. It
 * says who wants to talk and nothing about what was said. The server enforces
 * this too — see the push use case — and this is the second half of the same
 * promise.
 */
self.addEventListener('push', (event) => {
  const payload = readPayload(event);

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Same tag replaces rather than stacks: five "someone is in the room"
      // notifications is a reason to turn them off forever.
      tag: payload.tag,
      renotify: payload.urgent,
      // A ringing call may vibrate; nothing else earns it.
      vibrate: payload.urgent ? [120, 60, 120] : undefined,
      requireInteraction: payload.urgent,
      data: { url: payload.url },
    }),
  );
});

function readPayload(event) {
  const fallback = {
    title: 'Loverlink',
    body: 'Something happened while you were away.',
    url: '/rooms',
    tag: 'loverlink',
    urgent: false,
  };

  if (event.data === null || event.data === undefined) return fallback;

  try {
    const data = event.data.json();
    return {
      title: typeof data.title === 'string' ? data.title : fallback.title,
      body: typeof data.body === 'string' ? data.body : fallback.body,
      url: typeof data.url === 'string' ? data.url : fallback.url,
      tag: typeof data.tag === 'string' ? data.tag : fallback.tag,
      urgent: data.urgent === true,
    };
  } catch {
    return fallback;
  }
}

/**
 * Tapping a notification.
 *
 * FOCUSES AN EXISTING TAB rather than opening a new one. Someone who already
 * has the app open, possibly in a room, must not end up with a second copy —
 * two tabs with two sockets and two microphones is a genuinely bad time.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = event.notification.data?.url ?? '/rooms';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          // Navigate the existing tab if it is somewhere else. `navigate` is
          // not available in every browser, so a failure is ignored rather
          // than allowed to reject the whole handler.
          if ('navigate' in client) {
            await client.navigate(target).catch(() => undefined);
          }
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});

/**
 * The subscription was rotated or revoked by the browser.
 *
 * This happens for real — a browser update, a long silence, a user clearing
 * site data — and a server that does not hear about it keeps pushing into a
 * dead endpoint until it is told otherwise. Telling the page lets it re-
 * subscribe and send the new endpoint up.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'push-subscription-changed' });
      }
    })(),
  );
});
