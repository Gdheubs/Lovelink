'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, onAuthChange, type MyProfile } from './apiClient';

/**
 * Session state for the whole app.
 *
 * WHY A CONTEXT AND NOT A STORE LIBRARY
 * -------------------------------------
 * There is exactly one piece of global UI state at this stage — "who is signed
 * in" — and it changes on sign-in, sign-out and profile edit. A context is the
 * right size for that. Reaching for a state library here would add a dependency
 * and a set of conventions to serve one value.
 *
 * THE THREE-STATE LOADING MODEL
 * -----------------------------
 * `status` is deliberately not a boolean. On first paint the app does not yet
 * know whether there is a session — it has to try the refresh cookie first —
 * and collapsing that into `isAuthenticated: false` makes every protected page
 * flash the sign-in screen before redirecting back. Three states let the UI
 * render a neutral loading state instead of a wrong one.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  profile: MyProfile | null;
  /** Re-read the profile, e.g. after an edit. */
  refresh: () => Promise<void>;
  signOut: (allDevices?: boolean) => Promise<void>;
  /** Called by the sign-in screen once tokens are held. */
  onSignedIn: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [profile, setProfile] = useState<MyProfile | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await api.getMyProfile());
      setStatus('authenticated');
    } catch {
      setProfile(null);
      setStatus('anonymous');
    }
  }, []);

  /**
   * On mount, try to restore a session from the httpOnly refresh cookie.
   *
   * This is why the access token can live in memory: a page reload loses it,
   * and this recovers it without the long-lived credential ever being readable
   * by script.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await api.restoreSession();
      if (cancelled) return;

      if (restored) {
        await loadProfile();
      } else {
        setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  /**
   * React to token changes made elsewhere — most importantly, apiClient
   * clearing the token when a refresh fails mid-session. Without this, the UI
   * would keep showing a signed-in shell while every request 401s.
   */
  useEffect(() => {
    return onAuthChange((token) => {
      if (token === null) {
        setProfile(null);
        setStatus('anonymous');
      }
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      profile,
      refresh: loadProfile,
      async signOut(allDevices = false) {
        await api.logout(allDevices);
        setProfile(null);
        setStatus('anonymous');
      },
      onSignedIn: loadProfile,
    }),
    [status, profile, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    // A clear message beats `cannot read property of null` three components deep.
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}
