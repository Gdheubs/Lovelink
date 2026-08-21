import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL, getAccessToken } from './apiClient';

/**
 * THE ONLY MODULE IN THE FRONTEND THAT TOUCHES SOCKET.IO.
 *
 * Same rule as `apiClient.ts`, for the same reasons: one place that knows the
 * URL, one place that attaches the token, one place that handles reconnection.
 *
 * THE RECONNECT CONTRACT — the part most likely to be got wrong
 * ------------------------------------------------------------
 * Mobile clients disconnect constantly: a tunnel, a locked screen, a network
 * handover. When the socket comes back, the client's view of the room is stale
 * by an unknown amount, and there is no way to know which events it missed.
 *
 * The server's answer is `room:state` — a FULL SNAPSHOT sent on join and on
 * every re-join. So the correct client behaviour on reconnect is to discard
 * local state and re-join every room, rather than trying to reconcile.
 * `onReconnect` exists so screens can do exactly that, and the alternative
 * (patching a delta log) is what produces member lists that slowly diverge from
 * reality.
 *
 * Server event payload types mirror `domain/ports/RealtimeTransport.ts`. They
 * are duplicated rather than shared because the frontend is a separate
 * deployable that must keep working against a slightly older server; a shared
 * type would make every wire change a lockstep deploy.
 */

export interface ServerEventMap {
  'room:state': RoomState;
  'user:joined': { roomId: string; member: RoomMemberView };
  'user:left': { roomId: string; userId: string };
  'chat:message': ChatMessageView;
  'chat:typing': { roomId: string; userId: string };
  'reaction:shown': { roomId: string; userId: string; reaction: string };
  'hand:raised': { roomId: string; userId: string; raised: boolean };
  'speaker:promoted': {
    roomId: string;
    userId: string;
    mediaToken?: { token: string; url: string; roomName: string; expiresAt: string };
  };
  'speaker:demoted': { roomId: string; userId: string; reason: string };
  'room:muted': { roomId: string; userId: string; muted: boolean };
  'room:kicked': { roomId: string; userId: string };
  'dm:requested': { fromUserId: string; from: PublicProfileView };
  'dm:opened': { withUserId: string; with: PublicProfileView };
  'dm:message': ChatMessageView;
  'call:incoming': { fromUserId: string; from: PublicProfileView; callRoomId: string };
  'call:accepted': {
    withUserId: string;
    callRoomId: string;
    mediaToken: { token: string; url: string; roomName: string; expiresAt: string };
  };
  'call:declined': { withUserId: string };
  'surprise:received': { surpriseId: string; from: string };
  'user:banned': { reason: string; permanent: boolean };
  error: { code: string; message: string };
}

export interface PublicProfileView {
  id: string;
  displayName: string;
  avatarSeed: string;
  tier: string;
}

export interface RoomMemberView {
  user: PublicProfileView;
  role: 'listener' | 'speaker' | 'host';
  mutedByHost: boolean;
  handRaised: boolean;
}

export interface ChatMessageView {
  id: string;
  roomId: string | null;
  from: PublicProfileView;
  text: string;
  sentAt: string;
}

export interface RoomState {
  roomId: string;
  title: string;
  category: string;
  hostUserId: string;
  maxSpeakers: number;
  members: RoomMemberView[];
  raisedHands: string[];
  recentMessages: ChatMessageView[];
  selfRole: 'listener' | 'speaker' | 'host';
  /**
   * A media credential for THIS viewer, minted by the server.
   *
   * For a listener it carries canPublish=false. The client never decides that
   * — a publishing token exists only because a host approved someone, and it
   * arrives via `speaker:promoted`.
   *
   * Absent when the media server was unreachable, in which case the room
   * degrades to text rather than failing to open.
   */
  mediaToken?: {
    token: string;
    url: string;
    roomName: string;
    canPublish: boolean;
    expiresAt: string;
  };
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

let socket: Socket | null = null;
let connectionState: ConnectionState = 'idle';

const stateListeners = new Set<(state: ConnectionState) => void>();
const reconnectListeners = new Set<() => void>();

function setConnectionState(next: ConnectionState): void {
  connectionState = next;
  for (const listener of stateListeners) listener(next);
}

/** Heartbeat interval. Must be comfortably under the server's PRESENCE_TTL. */
const HEARTBEAT_MS = 15_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export const realtime = {
  connect(): Socket {
    if (socket !== null && socket.connected) return socket;

    const token = getAccessToken();
    if (token === null) {
      throw new Error('Cannot open a socket before signing in.');
    }

    setConnectionState('connecting');

    socket = io(API_BASE_URL, {
      // The server authenticates ONCE, at connect, from this value. It is read
      // fresh on every reconnect attempt below, so a refreshed access token is
      // picked up without tearing the connection down manually.
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      // Effectively forever. A user in a tunnel should rejoin when they come
      // out, not find themselves silently ejected.
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      setConnectionState('connected');
      startHeartbeat();
    });

    socket.io.on('reconnect_attempt', () => {
      setConnectionState('reconnecting');
      // Re-read the token: the access token may have been refreshed while we
      // were disconnected, and reconnecting with the stale one fails auth.
      const fresh = getAccessToken();
      if (fresh !== null && socket !== null) {
        socket.auth = { token: fresh };
      }
    });

    socket.on('connect_error', (error) => {
      // An auth failure is terminal — retrying with the same rejected token
      // just hammers the server. Anything else is worth retrying.
      if (error.message === 'UNAUTHENTICATED' || error.message === 'BANNED') {
        setConnectionState('failed');
        socket?.disconnect();
      }
    });

    socket.on('connect', () => {
      // Fired on the FIRST connect and on every reconnect. Screens use this to
      // re-join their room and take a fresh snapshot rather than trusting the
      // state they were holding.
      for (const listener of reconnectListeners) listener();
    });

    socket.on('disconnect', () => {
      stopHeartbeat();
      setConnectionState('reconnecting');
    });

    return socket;
  },

  disconnect(): void {
    stopHeartbeat();
    socket?.disconnect();
    socket = null;
    setConnectionState('idle');
  },

  /** Subscribe to a server event. Returns an unsubscribe function. */
  on<E extends keyof ServerEventMap>(
    event: E,
    handler: (payload: ServerEventMap[E]) => void,
  ): () => void {
    const active = socket;
    if (active === null) return () => undefined;

    active.on(event as string, handler as (...args: unknown[]) => void);
    return () => {
      active.off(event as string, handler as (...args: unknown[]) => void);
    };
  },

  /** Send a client event. Silently ignored when disconnected — the reconnect
   *  snapshot will bring the client back in sync, and queueing user actions
   *  across a disconnect would replay stale intent (a chat message sent to a
   *  room they have since left). */
  emit(event: string, payload: unknown): void {
    socket?.emit(event, payload);
  },

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    stateListeners.add(listener);
    listener(connectionState);
    return () => stateListeners.delete(listener);
  },

  onReconnect(listener: () => void): () => void {
    reconnectListeners.add(listener);
    return () => reconnectListeners.delete(listener);
  },

  getState(): ConnectionState {
    return connectionState;
  },
};

/**
 * Presence heartbeat.
 *
 * The server expires presence entries that stop heartbeating (see
 * PresenceStore) — that is how it detects the phone that locked mid-conversation
 * without sending `room:leave`. This timer is the client's half of that
 * contract.
 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    socket?.emit('presence:heartbeat', {});
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
