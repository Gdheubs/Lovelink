'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { registerServiceWorker, watchForSubscriptionChange } from './pwa';
import { api } from './apiClient';

/**
 * Starts the two background things a PWA needs, and nothing else.
 *
 *   1. Registers the service worker — the prerequisite for both installation
 *      and push.
 *   2. Reports the browser's timezone, once, per session.
 *
 * WHY THE TIMEZONE IS SENT FROM HERE
 * ----------------------------------
 * Streaks are counted in the user's own days, and the server stores the zone
 * rather than reading a header, so that a socket join, a REST call and a
 * background job all agree about which day it is for this person. The browser
 * is the only thing that actually knows the answer, so it has to tell the
 * server — and this is the one place in the app where that is true regardless
 * of which screen is open.
 *
 * IT DOES NOT ASK FOR NOTIFICATION PERMISSION. Prompting on load is how
 * permission gets refused permanently: the browser will not ask twice, and
 * undoing a refusal means finding a settings screen most people never find. The
 * ask lives behind a deliberate tap, in the panel that has just explained what
 * it is for.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  useEffect(() => {
    registerServiceWorker();
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    return watchForSubscriptionChange();
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated') return;

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string' || zone.length === 0) return;

    // Best-effort. A failure costs a streak boundary being computed in the
    // wrong zone until next time, which is worth exactly zero interruptions.
    void api.setTimeZone(zone).catch(() => undefined);
  }, [status]);

  return <>{children}</>;
}
