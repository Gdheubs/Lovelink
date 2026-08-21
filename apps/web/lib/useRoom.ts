'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  realtime,
  type ChatMessageView,
  type ConnectionState,
  type RoomMemberView,
  type RoomState,
} from './realtimeClient';

/**
 * Everything a room screen needs, in one hook.
 *
 * THE DESIGN DECISION THAT MATTERS: SNAPSHOT WINS
 * ----------------------------------------------
 * The server sends a FULL `room:state` on join and on every re-join. This hook
 * treats that snapshot as the truth and REPLACES its state with it, rather than
 * trying to merge it with whatever it was holding.
 *
 * That is the whole reconnection strategy. A mobile client drops constantly —
 * a tunnel, a lock screen, a network handover — and it cannot know which
 * events it missed while away. Merging would leave the member list subtly wrong
 * with nothing to detect it; replacing makes the client self-correcting: however
 * wrong it was, it is right again after the next snapshot.
 *
 * Incremental events (`user:joined`, `user:left`, `chat:message`) are applied
 * on top for responsiveness. They are an optimisation, not the source of truth,
 * and every one of them is safe to lose.
 *
 * WHY IT RE-JOINS ON RECONNECT
 * ----------------------------
 * The server expires presence for a client that stops heartbeating. After a
 * long drop the server has already reaped this user and told the room they
 * left. Re-joining is what puts them back — and it is why `onReconnect` exists
 * on the realtime client at all.
 */

export interface UseRoomResult {
  readonly connection: ConnectionState;
  readonly state: RoomState | null;
  readonly messages: readonly ChatMessageView[];
  readonly typingUserIds: readonly string[];
  readonly error: string | null;
  sendMessage: (text: string) => void;
  sendTyping: () => void;
  sendReaction: (reaction: string) => void;
  leave: () => void;
}

/** How long a typing indicator lingers before it is assumed stale. */
const TYPING_TIMEOUT_MS = 4_000;

/** Matches the server's snapshot limit; keeps the DOM bounded in a busy room. */
const MAX_RENDERED_MESSAGES = 200;

export function useRoom(roomId: string | null): UseRoomResult {
  const [connection, setConnection] = useState<ConnectionState>(realtime.getState());
  const [state, setState] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessageView[]>([]);
  const [typingUserIds, setTypingUserIds] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Kept in a ref as well as state so the reconnect handler — which is
  // registered once — always sees the CURRENT room rather than the one that was
  // current when it was registered.
  const roomIdRef = useRef<string | null>(roomId);
  roomIdRef.current = roomId;

  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (roomId === null) return;

    const socket = realtime.connect();
    const unsubscribers: (() => void)[] = [];

    unsubscribers.push(realtime.onConnectionState(setConnection));

    // -- the snapshot: replaces everything --------------------------------
    unsubscribers.push(
      realtime.on('room:state', (snapshot) => {
        if (snapshot.roomId !== roomIdRef.current) return;
        setState(snapshot);
        setMessages(snapshot.recentMessages);
        setError(null);
      }),
    );

    // -- incremental updates ----------------------------------------------
    unsubscribers.push(
      realtime.on('user:joined', (payload) => {
        if (payload.roomId !== roomIdRef.current) return;
        setState((current) => {
          if (current === null) return current;
          // Guard against a duplicate arrival: the snapshot may already list
          // them if the events crossed.
          if (current.members.some((m) => m.user.id === payload.member.user.id)) return current;
          return { ...current, members: sortMembers([...current.members, payload.member]) };
        });
      }),
    );

    unsubscribers.push(
      realtime.on('user:left', (payload) => {
        if (payload.roomId !== roomIdRef.current) return;
        setState((current) =>
          current === null
            ? current
            : { ...current, members: current.members.filter((m) => m.user.id !== payload.userId) },
        );
      }),
    );

    unsubscribers.push(
      realtime.on('chat:message', (message) => {
        if (message.roomId !== roomIdRef.current) return;
        setMessages((current) => {
          // The server echoes the sender's own message back, so a message can
          // arrive that is already rendered if a snapshot landed in between.
          if (current.some((m) => m.id === message.id)) return current;
          const next = [...current, message];
          return next.length > MAX_RENDERED_MESSAGES
            ? next.slice(next.length - MAX_RENDERED_MESSAGES)
            : next;
        });

        // Someone who just spoke is no longer typing.
        clearTyping(message.from.id);
      }),
    );

    unsubscribers.push(
      realtime.on('chat:typing', (payload) => {
        if (payload.roomId !== roomIdRef.current) return;
        markTyping(payload.userId);
      }),
    );

    unsubscribers.push(
      realtime.on('error', (payload) => {
        // Presence lapsed while we were away — the server is telling us to
        // re-join rather than silently pretending we are still here.
        if (payload.code === 'NOT_FOUND') {
          socket.emit('room:join', { roomId: roomIdRef.current });
          return;
        }
        setError(payload.message);
      }),
    );

    // -- join, and re-join after every reconnect ---------------------------
    const join = (): void => {
      const current = roomIdRef.current;
      if (current !== null) socket.emit('room:join', { roomId: current });
    };

    unsubscribers.push(realtime.onReconnect(join));
    if (socket.connected) join();

    // -- heartbeat: name the room we believe we are in ---------------------
    //
    // Naming it is what lets the server tell us we have been dropped. Without
    // it, a lapsed client sits rendering a room it is no longer in.
    const heartbeat = setInterval(() => {
      const current = roomIdRef.current;
      if (current !== null) socket.emit('presence:heartbeat', { rooms: [current] });
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
    };

    function markTyping(userId: string): void {
      setTypingUserIds((current) => (current.includes(userId) ? current : [...current, userId]));

      const existing = typingTimers.current.get(userId);
      if (existing !== undefined) clearTimeout(existing);

      // Typing indicators are fire-and-forget — there is no "stopped typing"
      // event — so each one expires on its own.
      typingTimers.current.set(
        userId,
        setTimeout(() => clearTyping(userId), TYPING_TIMEOUT_MS),
      );
    }

    function clearTyping(userId: string): void {
      const timer = typingTimers.current.get(userId);
      if (timer !== undefined) clearTimeout(timer);
      typingTimers.current.delete(userId);
      setTypingUserIds((current) => current.filter((id) => id !== userId));
    }
  }, [roomId]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || roomIdRef.current === null) return;
    // NOT rendered optimistically: the server echoes it back, and rendering
    // what the server accepted avoids showing text it may have rejected or
    // normalized differently.
    realtime.emit('chat:send', { roomId: roomIdRef.current, text: trimmed });
  }, []);

  const sendTyping = useCallback(() => {
    if (roomIdRef.current === null) return;
    realtime.emit('chat:typing', { roomId: roomIdRef.current });
  }, []);

  const sendReaction = useCallback((reaction: string) => {
    if (roomIdRef.current === null) return;
    realtime.emit('reaction:send', { roomId: roomIdRef.current, reaction });
  }, []);

  const leave = useCallback(() => {
    if (roomIdRef.current === null) return;
    realtime.emit('room:leave', { roomId: roomIdRef.current });
  }, []);

  return {
    connection,
    state,
    messages,
    typingUserIds,
    error,
    sendMessage,
    sendTyping,
    sendReaction,
    leave,
  };
}

/** Host first, then speakers, then listeners, alphabetical within each group. */
const ROLE_ORDER: Record<string, number> = { host: 0, speaker: 1, listener: 2 };

function sortMembers(members: readonly RoomMemberView[]): RoomMemberView[] {
  return [...members].sort((a, b) => {
    const byRole = (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3);
    if (byRole !== 0) return byRole;
    return a.user.displayName.localeCompare(b.user.displayName);
  });
}
