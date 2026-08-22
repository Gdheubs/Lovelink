'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { api, type PublicProfile } from './apiClient';
import { realtime, type PublicProfileView } from './realtimeClient';

/**
 * THE APP-WIDE SIGNALLING LAYER — a ringing phone has to reach you anywhere.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Until Phase 5 the socket was opened by `useRoom`, on the room screen, and
 * nowhere else. That was fine when every realtime event belonged to a room. It
 * is not fine for a 1:1 call: the entire premise of `call:incoming` is that it
 * finds you while you are reading your connections list, or the home screen, or
 * doing nothing at all. A socket that only exists on one route means a call
 * that only rings on one route, which is the same as a call that does not work.
 *
 * So the socket is opened here, once, as soon as there is a session, and lives
 * for as long as the tab does. `useRoom` calls `realtime.connect()` too and
 * gets the same connection back.
 *
 * WHY THE CALL UI IS RENDERED HERE AND NOT ON A PAGE
 * -------------------------------------------------
 * For the same reason. An incoming call is not a destination — you do not
 * navigate to it, it arrives. Putting the sheet in the layout means answering a
 * call never loses the page you were on, and hanging up returns you to it
 * rather than to wherever the call screen decided to send you.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It never decides whether an action is ALLOWED. `canCall` from the server
 * decides which buttons a page renders, and the server re-checks every action
 * when it is invoked. Nothing here is authorization; it is all presentation of
 * events the server chose to send.
 */

/** A call ringing at this user, which they have not answered. */
export interface IncomingCall {
  readonly fromUserId: string;
  readonly from: PublicProfileView;
  readonly callRoomId: string;
}

/** A call this user is in, or is placing. */
export interface ActiveCall {
  readonly withUserId: string;
  readonly withName: string;
  /** `dialling` is the caller waiting; `connected` means audio is up. */
  readonly phase: 'dialling' | 'connected';
  readonly since: number;
}

/**
 * Something that happened while the user was looking elsewhere.
 *
 * Deliberately small and deliberately NOT persisted. This is a nudge to look at
 * a screen, not an inbox — a notification store that outlives the tab is a
 * second source of truth for state the server already owns, and the two drift.
 */
export interface Nudge {
  readonly id: string;
  readonly kind: 'dm_request' | 'dm_message' | 'surprise';
  readonly text: string;
  readonly at: number;
}

interface SignallingValue {
  readonly connected: boolean;
  readonly incomingCall: IncomingCall | null;
  readonly activeCall: ActiveCall | null;
  readonly micEnabled: boolean;
  readonly nudges: readonly Nudge[];
  readonly lastError: string | null;

  /** Dial someone. Throws nothing — failures surface as `lastError`. */
  placeCall(userId: string, displayName: string): void;
  acceptCall(): void;
  declineCall(): void;
  hangUp(): void;
  toggleMic(): void;
  dismissNudge(id: string): void;
  clearError(): void;
}

const SignallingContext = createContext<SignallingValue | null>(null);

/** How long a dialling call waits before giving up, matching the server's ring timeout. */
const RING_TIMEOUT_MS = 60_000;

/**
 * The media SDK is loaded ONLY when a call actually connects.
 *
 * This provider sits in the root layout, so a static import would put roughly
 * 150kB of LiveKit into the first load of every screen in the app — the sign-in
 * page included. Almost nobody on any given screen is about to be in a call,
 * and the anchor use case is a phone on mobile data.
 *
 * Loading it at `call:accepted` costs a moment that is already spent waiting
 * for the room connection, and the module cache means a second call pays
 * nothing. `useRoom` still imports it statically, which is right: on a room
 * screen you ARE about to publish or listen.
 */
async function mediaClient() {
  const module = await import('./mediaClient');
  return module.media;
}

export function SignallingProvider({ children }: { children: ReactNode }) {
  const { status, profile } = useAuth();

  const [connected, setConnected] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [nudges, setNudges] = useState<readonly Nudge[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  /**
   * The current call, readable from inside event handlers.
   *
   * Handlers are registered once and would otherwise close over the state as it
   * was at subscription time — the classic stale-closure bug, which here would
   * mean hanging up the wrong call or ignoring a real one.
   */
  const activeCallRef = useRef<ActiveCall | null>(null);
  activeCallRef.current = activeCall;

  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushNudge = useCallback((kind: Nudge['kind'], text: string) => {
    const nudge: Nudge = { id: `${kind}-${Date.now()}-${Math.random()}`, kind, text, at: Date.now() };
    // Bounded: this is a nudge, not a log.
    setNudges((current) => [nudge, ...current].slice(0, 5));
  }, []);

  const clearRingTimer = useCallback(() => {
    if (ringTimer.current !== null) {
      clearTimeout(ringTimer.current);
      ringTimer.current = null;
    }
  }, []);

  /** Tear down local call state and leave the audio room. */
  const endLocally = useCallback(() => {
    clearRingTimer();
    setActiveCall(null);
    setIncomingCall(null);
    // If the SDK was never loaded there is nothing to disconnect, and importing
    // it just to call `disconnect()` on a client that never connected would
    // defeat the point of loading it lazily at all.
    void mediaClient()
      .then((media) => media.disconnect())
      .catch(() => undefined);
  }, [clearRingTimer]);

  // -- the socket ------------------------------------------------------------

  useEffect(() => {
    if (status !== 'authenticated') {
      setConnected(false);
      return;
    }

    realtime.connect();

    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      realtime.onConnectionState((state) => {
        setConnected(state === 'connected');
      }),
    );

    unsubscribers.push(
      realtime.on('call:incoming', (payload) => {
        // A call arriving while already in one: the server refuses to place it,
        // so this can only be a duplicate delivery. Ignoring it is safer than
        // replacing a live call's UI.
        if (activeCallRef.current !== null) return;

        setIncomingCall({
          fromUserId: payload.fromUserId,
          from: payload.from,
          callRoomId: payload.callRoomId,
        });

        // Stop ringing on the client too. The server will refuse a late answer
        // anyway, but a phone that rings forever after the caller gave up is
        // its own small cruelty.
        clearRingTimer();
        ringTimer.current = setTimeout(() => setIncomingCall(null), RING_TIMEOUT_MS);
      }),
    );

    unsubscribers.push(
      realtime.on('call:accepted', (payload) => {
        clearRingTimer();
        setIncomingCall(null);

        setActiveCall((current) => ({
          withUserId: payload.withUserId,
          withName: current?.withName ?? 'your call',
          phase: 'connected',
          since: current?.since ?? Date.now(),
        }));

        // The token is the ONLY thing that gets us into the room, and it was
        // minted for this device at the moment both people agreed.
        void mediaClient()
          .then(async (media) => {
            await media.connect({
              token: payload.mediaToken.token,
              url: payload.mediaToken.url,
              roomName: payload.mediaToken.roomName,
              expiresAt: payload.mediaToken.expiresAt,
            });
            await media.setMicrophoneEnabled(true);
            setMicEnabled(true);
          })
          .catch(() => {
            setLastError('Could not open the microphone. Check your browser permissions.');
            endLocally();
          });
      }),
    );

    unsubscribers.push(
      realtime.on('call:declined', (payload) => {
        // Sent for a decline AND for a hang-up — they are the same operation
        // server-side. Either way this call is over.
        if (
          activeCallRef.current !== null &&
          activeCallRef.current.withUserId !== payload.withUserId
        ) {
          return;
        }
        endLocally();
      }),
    );

    unsubscribers.push(
      realtime.on('dm:requested', (payload) => {
        pushNudge('dm_request', `${payload.from.displayName} would like to message you`);
      }),
    );

    unsubscribers.push(
      realtime.on('dm:message', (payload) => {
        // Skip the echo of our own message — the server sends it so a user's
        // other devices stay in step, and nudging yourself is nonsense.
        if (profile !== null && payload.from.id === profile.id) return;
        pushNudge('dm_message', `${payload.from.displayName} sent you a message`);
      }),
    );

    unsubscribers.push(
      realtime.on('surprise:received', (payload) => {
        pushNudge('surprise', `${payload.from} opened your surprise`);
      }),
    );

    unsubscribers.push(
      realtime.on('error', (payload) => {
        // Only surface signalling errors here; room screens handle their own.
        if (payload.code === 'CALL_BUSY') {
          setLastError('They are already on a call.');
          endLocally();
          return;
        }
        if (payload.code === 'NO_PENDING_CALL') {
          setLastError('That call is no longer available.');
          endLocally();
          return;
        }
        if (payload.code === 'TRUST_LADDER_VIOLATION' && activeCallRef.current !== null) {
          setLastError(payload.message);
          endLocally();
        }
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      clearRingTimer();
    };
    // `profile` is read inside one handler; re-subscribing when it changes is
    // cheap and avoids a stale identity comparison on the DM echo.
  }, [status, profile, pushNudge, clearRingTimer, endLocally]);

  // -- actions ---------------------------------------------------------------

  const placeCall = useCallback(
    (userId: string, displayName: string) => {
      setLastError(null);
      setActiveCall({ withUserId: userId, withName: displayName, phase: 'dialling', since: Date.now() });
      realtime.emit('call:invite', { userId });

      // Give up locally when the server's ring window closes, so a caller is
      // not left staring at "calling..." forever.
      clearRingTimer();
      ringTimer.current = setTimeout(() => {
        if (activeCallRef.current?.phase === 'dialling') {
          setLastError('No answer.');
          endLocally();
        }
      }, RING_TIMEOUT_MS);
    },
    [clearRingTimer, endLocally],
  );

  const acceptCall = useCallback(() => {
    const call = incomingCall;
    if (call === null) return;

    setLastError(null);
    clearRingTimer();
    // Optimistic, so the sheet closes instantly. `call:accepted` follows with
    // the token that actually opens the audio.
    setActiveCall({
      withUserId: call.fromUserId,
      withName: call.from.displayName,
      phase: 'dialling',
      since: Date.now(),
    });
    setIncomingCall(null);
    realtime.emit('call:accept', { userId: call.fromUserId });
  }, [incomingCall, clearRingTimer]);

  const declineCall = useCallback(() => {
    const call = incomingCall;
    if (call === null) return;

    setIncomingCall(null);
    clearRingTimer();
    realtime.emit('call:decline', { userId: call.fromUserId });
  }, [incomingCall, clearRingTimer]);

  const hangUp = useCallback(() => {
    const call = activeCallRef.current;
    endLocally();
    if (call === null) return;

    realtime.emit('call:decline', { userId: call.withUserId });
    // Belt and braces over HTTP: this is the one call action that must work
    // when the socket is exactly what has gone wrong. Hanging up twice is
    // explicitly not an error server-side.
    void api.endCall(call.withUserId).catch(() => undefined);
  }, [endLocally]);

  const toggleMic = useCallback(() => {
    const next = !micEnabled;
    setMicEnabled(next);
    void mediaClient()
      .then((media) => media.setMicrophoneEnabled(next))
      // Put the button back if the mic refused: a mute control that lies about
      // whether the microphone is open is the worst possible bug here.
      .catch(() => setMicEnabled(!next));
  }, [micEnabled]);

  const dismissNudge = useCallback((id: string) => {
    setNudges((current) => current.filter((nudge) => nudge.id !== id));
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  const value = useMemo<SignallingValue>(
    () => ({
      connected,
      incomingCall,
      activeCall,
      micEnabled,
      nudges,
      lastError,
      placeCall,
      acceptCall,
      declineCall,
      hangUp,
      toggleMic,
      dismissNudge,
      clearError,
    }),
    [
      connected,
      incomingCall,
      activeCall,
      micEnabled,
      nudges,
      lastError,
      placeCall,
      acceptCall,
      declineCall,
      hangUp,
      toggleMic,
      dismissNudge,
      clearError,
    ],
  );

  return (
    <SignallingContext.Provider value={value}>
      {children}
      <CallOverlay />
    </SignallingContext.Provider>
  );
}

export function useSignalling(): SignallingValue {
  const value = useContext(SignallingContext);
  if (value === null) {
    throw new Error('useSignalling must be used inside a SignallingProvider.');
  }
  return value;
}

/**
 * The ringing sheet, the in-call bar, and any nudges.
 *
 * Rendered by the provider itself so that every screen gets it without opting
 * in — a screen that forgot to include it would be a screen where calls
 * silently do not ring.
 */
function CallOverlay() {
  const {
    incomingCall,
    activeCall,
    micEnabled,
    nudges,
    lastError,
    acceptCall,
    declineCall,
    hangUp,
    toggleMic,
    dismissNudge,
    clearError,
  } = useSignalling();

  return (
    <>
      {nudges.length > 0 && (
        <div className="nudge-stack" role="status" aria-live="polite">
          {nudges.map((nudge) => (
            <button
              key={nudge.id}
              type="button"
              className="nudge"
              onClick={() => dismissNudge(nudge.id)}
            >
              {nudge.text}
              <span className="nudge-dismiss" aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {lastError !== null && (
        <div className="call-error" role="alert">
          {lastError}
          <button type="button" onClick={clearError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {incomingCall !== null && (
        // `alertdialog` rather than `dialog`: this demands a decision and
        // interrupts, which is exactly what the role means.
        <div className="call-sheet" role="alertdialog" aria-modal="true" aria-label="Incoming call">
          <div className="call-sheet-inner">
            <p className="call-sheet-who">{incomingCall.from.displayName}</p>
            <p className="call-sheet-sub">is calling you</p>
            <div className="call-sheet-actions">
              <button type="button" className="call-decline" onClick={declineCall}>
                Decline
              </button>
              <button type="button" className="call-accept" onClick={acceptCall}>
                Answer
              </button>
            </div>
          </div>
        </div>
      )}

      {activeCall !== null && (
        <div className="call-bar" role="status">
          <span className="call-bar-who">
            {activeCall.phase === 'dialling' ? 'Calling' : 'On a call with'}{' '}
            <strong>{activeCall.withName}</strong>
            {activeCall.phase === 'dialling' && <span className="call-bar-dots">…</span>}
          </span>

          <span className="call-bar-actions">
            {activeCall.phase === 'connected' && (
              <button
                type="button"
                onClick={toggleMic}
                aria-pressed={!micEnabled}
                className={micEnabled ? 'mic-on' : 'mic-off'}
              >
                {micEnabled ? 'Mute' : 'Unmute'}
              </button>
            )}
            <button type="button" className="call-hangup" onClick={hangUp}>
              {activeCall.phase === 'dialling' ? 'Cancel' : 'Hang up'}
            </button>
          </span>
        </div>
      )}
    </>
  );
}

/** Convenience for screens that only need to know if someone can be called now. */
export function useCanCall(): boolean {
  const { connected, activeCall } = useSignalling();
  return connected && activeCall === null;
}

export type { PublicProfile };
