'use client';

import { api } from './apiClient';

/**
 * THE PWA EDGE — the only module that touches the service worker,
 * `beforeinstallprompt`, or the Push API.
 *
 * Same rule as `apiClient` and `realtimeClient`, for the same reason: these are
 * three browser APIs with wildly different support across the devices this
 * product actually runs on, and the fallbacks belong in one place rather than
 * scattered through components that then each get them subtly wrong.
 *
 * WHAT "NOT SUPPORTED" MEANS HERE
 * -------------------------------
 * Every function below degrades to doing nothing rather than throwing. A
 * browser without push is not a broken browser — it is an iPhone that has not
 * been added to the home screen, which is most iPhones — and the app has to
 * work completely for that person, minus the notification.
 */

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

/**
 * Register the worker.
 *
 * Deliberately NOT awaited by anything that renders. Registration competes with
 * the first paint for the same network and CPU, and a user staring at a blank
 * screen while a background worker installs is a worse trade than a worker that
 * arrives a second late.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // `load` rather than immediately: the worker's install step fetches the whole
  // shell, and doing that while the page is still fetching its own assets makes
  // the first visit measurably slower.
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // A failed registration costs push and offline, and nothing else. It is
      // not worth interrupting anyone over.
    });
  });
}

/**
 * Listen for the worker telling us the push subscription was rotated.
 *
 * Browsers rotate subscriptions on their own schedule, and a server pushing to
 * a dead endpoint gets silence rather than an error it can act on. Re-
 * subscribing here is what keeps notifications working across that.
 */
export function watchForSubscriptionChange(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => undefined;
  }

  const handler = (event: MessageEvent): void => {
    if ((event.data as { type?: string } | null)?.type === 'push-subscription-changed') {
      void enablePush().catch(() => undefined);
    }
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

// ---------------------------------------------------------------------------
// Install prompt
// ---------------------------------------------------------------------------

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * The captured prompt.
 *
 * Chromium fires `beforeinstallprompt` exactly once, early, and the event is
 * only usable if `preventDefault()` was called on it — so it has to be caught
 * at module load, long before any component decides it wants to offer an
 * install. Holding it here is what makes "Add to home screen" available at a
 * moment WE choose rather than whenever the browser felt like it.
 */
let deferredPrompt: InstallPromptEvent | null = null;
const installListeners = new Set<(available: boolean) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    for (const listener of installListeners) listener(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    for (const listener of installListeners) listener(false);
  });
}

export function onInstallAvailable(listener: (available: boolean) => void): () => void {
  installListeners.add(listener);
  listener(deferredPrompt !== null);
  return () => installListeners.delete(listener);
}

/**
 * Show the install prompt.
 *
 * @returns whether the person accepted. False also covers "there was no prompt
 *          to show", which is the case on iOS and on an already-installed app.
 */
export async function promptInstall(): Promise<boolean> {
  const prompt = deferredPrompt;
  if (prompt === null) return false;

  // The event is single-use. Clearing it first means a double tap cannot try to
  // show it twice, which throws.
  deferredPrompt = null;
  for (const listener of installListeners) listener(false);

  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === 'accepted';
}

/** True when the app is running from a home screen rather than a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS predates the standard and never adopted it.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS has no install prompt at all — the user must use the Share sheet.
 *
 * Detected so the UI can show instructions instead of a button that cannot
 * work. Sniffing the platform is a last resort, and this is one of the few
 * places it is the only option: there is no capability to feature-detect,
 * because the capability is a human being tapping a menu.
 */
export function needsManualInstall(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (isInstalled()) return false;

  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  return isIos && deferredPrompt === null;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export type PushState = 'unsupported' | 'default' | 'granted' | 'denied';

export function pushState(): PushState {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';

  return Notification.permission as PushState;
}

/**
 * Ask for permission and register a subscription with the server.
 *
 * WHY THIS IS NEVER CALLED ON PAGE LOAD
 * -------------------------------------
 * A permission prompt with no context is refused by most people, and a refusal
 * is close to permanent — the browser will not ask again, and undoing it means
 * finding a settings screen most users never find. So this is only ever called
 * from a deliberate tap on something that has just explained what the
 * notification is for.
 *
 * @returns true when a subscription is now registered.
 */
export async function enablePush(): Promise<boolean> {
  if (pushState() === 'unsupported') return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const registration = await navigator.serviceWorker.ready;

  // The server's public VAPID key. Fetched rather than baked into the bundle so
  // that rotating it is a server deploy rather than a client one — and so a
  // deployment with push switched off simply returns nothing and this stops.
  const { publicKey } = await api.getPushKey();
  if (publicKey === null) return false;

  const existing = await registration.pushManager.getSubscription();

  // A subscription minted under a DIFFERENT key is useless: the server cannot
  // sign for it and every push is rejected. Rotating the key therefore means
  // dropping the old subscription rather than keeping a dead one.
  if (existing !== null && !subscribedWithKey(existing, publicKey)) {
    await existing.unsubscribe().catch(() => undefined);
  }

  const subscription =
    existing !== null && subscribedWithKey(existing, publicKey)
      ? existing
      : await registration.pushManager.subscribe({
          // Required to be true by every browser that implements this: a
          // subscription that could push silently would be a tracking channel.
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        });

  await api.registerPushSubscription(serialize(subscription));
  return true;
}

/** Stop notifications and forget the endpoint server-side. */
export async function disablePush(): Promise<void> {
  if (pushState() === 'unsupported') return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;

  // Server FIRST. If the local unsubscribe succeeded and the server call did
  // not, the server would keep pushing to an endpoint nobody is listening on —
  // whereas this order leaves at worst a live local subscription the server has
  // already forgotten, which is silent.
  await api.removePushSubscription(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

export interface SerializedSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function serialize(subscription: PushSubscription): SerializedSubscription {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
    },
  };
}

function subscribedWithKey(subscription: PushSubscription, publicKey: string): boolean {
  const applied = subscription.options.applicationServerKey;
  if (applied === null || applied === undefined) return false;
  return bytesToBase64Url(new Uint8Array(applied)) === publicKey;
}

/**
 * The VAPID key travels as base64url and the Push API wants raw bytes.
 *
 * base64url is not base64: `-` and `_` replace `+` and `/`, and the padding is
 * dropped. Feeding it to `atob` unconverted throws on roughly half of all keys,
 * which is exactly the kind of bug that looks like "push works on my machine".
 */
function base64UrlToBytes(value: string): ArrayBuffer {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

  // An ArrayBuffer rather than a view: `applicationServerKey` is typed as
  // BufferSource, and a Uint8Array over a SharedArrayBuffer-capable buffer no
  // longer satisfies it under recent lib.dom typings.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
