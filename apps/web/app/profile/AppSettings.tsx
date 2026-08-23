'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  disablePush,
  enablePush,
  isInstalled,
  needsManualInstall,
  onInstallAvailable,
  promptInstall,
  pushState,
  type PushState,
} from '../../lib/pwa';
import { api } from '../../lib/apiClient';

/**
 * Install and notification settings.
 *
 * WHY THE NOTIFICATION TOGGLE EXPLAINS ITSELF BEFORE IT ASKS
 * ----------------------------------------------------------
 * A browser permission prompt is close to one-shot. Refuse it and the browser
 * will not ask again; undoing that means finding a settings screen most people
 * never find. So the ask is never automatic and never bare — the copy below
 * says exactly what will and will not appear on a lock screen, and the prompt
 * only follows a deliberate tap on it.
 *
 * WHY IT PROMISES WHAT IT DOES
 * ----------------------------
 * "Who, not what" is a real guarantee, enforced server-side by the push use
 * case and again by the service worker. Saying it here is not marketing: it is
 * the thing a person needs to know before agreeing to have this product write
 * on their lock screen, and the product is built so that it is true.
 */
export function AppSettings() {
  const [push, setPush] = useState<PushState>('unsupported');
  const [installAvailable, setInstallAvailable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [manualInstall, setManualInstall] = useState(false);
  const [pushConfigured, setPushConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read on mount rather than during render: every one of these touches a
  // browser API that does not exist on the server.
  useEffect(() => {
    setPush(pushState());
    setInstalled(isInstalled());
    setManualInstall(needsManualInstall());
    return onInstallAvailable(setInstallAvailable);
  }, []);

  /**
   * Whether the SERVER can send push at all.
   *
   * A deployment with no VAPID keys returns no public key, and offering a
   * toggle there would mean a permission prompt answered "allow" followed by
   * silence forever — which teaches someone that this product's notifications
   * do not work.
   */
  useEffect(() => {
    let cancelled = false;

    void api
      .getPushKey()
      .then(({ publicKey }) => {
        if (!cancelled) setPushConfigured(publicKey !== null);
      })
      .catch(() => {
        if (!cancelled) setPushConfigured(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await enablePush();
      setPush(pushState());
      if (!granted && pushState() === 'denied') {
        // The browser will not ask again, so the only honest thing to do is
        // say where the setting lives.
        setError('Your browser is blocking notifications. You can change that in site settings.');
      }
    } catch {
      setError('We could not turn notifications on.');
    } finally {
      setBusy(false);
    }
  }, []);

  const turnOff = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush();
      // Permission stays "granted" — the browser keeps that, and we have only
      // dropped the subscription. Re-reading is still right: it is the truth.
      setPush(pushState());
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="card settings" aria-label="App settings">
      <h2 className="list-head">This device</h2>

      {/* -- install ------------------------------------------------------ */}
      {installed ? (
        <p className="faint">Installed. Loverlink opens like any other app.</p>
      ) : installAvailable ? (
        <div className="setting">
          <div>
            <p className="setting-title">Add to your home screen</p>
            <p className="faint">
              Opens full screen, and is the only way notifications work on some phones.
            </p>
          </div>
          <button
            type="button"
            className="button button--secondary composer__send"
            onClick={() => void promptInstall().then(() => setInstalled(isInstalled()))}
          >
            Install
          </button>
        </div>
      ) : manualInstall ? (
        /*
         * iOS has no install prompt — the user must use the Share sheet. A
         * button that cannot work would be worse than instructions.
         */
        <p className="faint">
          To install: tap the Share button, then <strong>Add to Home Screen</strong>. On iPhone
          that is also what makes notifications possible.
        </p>
      ) : null}

      {/* -- notifications ------------------------------------------------ */}
      {push === 'unsupported' || pushConfigured === false ? (
        <p className="faint">Notifications are not available on this device.</p>
      ) : (
        <div className="setting">
          <div>
            <p className="setting-title">Notifications</p>
            <p className="faint">
              For a call ringing, or someone asking to message you. They say <em>who</em>, never
              what was said — nothing you talk about here appears on a lock screen.
            </p>
          </div>

          {push === 'granted' ? (
            <button
              type="button"
              className="button button--secondary composer__send"
              disabled={busy}
              onClick={() => void turnOff()}
            >
              Turn off
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary composer__send"
              disabled={busy || push === 'denied'}
              onClick={() => void turnOn()}
            >
              {busy ? 'Just a moment…' : 'Turn on'}
            </button>
          )}
        </div>
      )}

      {error !== null && <p className="notice notice--error">{error}</p>}
    </section>
  );
}
