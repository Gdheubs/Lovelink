'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/AuthProvider';
import { useRoom } from '../../../lib/useRoom';
import { avatarFor } from '../../../lib/avatar';

/**
 * The room screen: member list, live chat, reactions.
 *
 * NO AUDIO CONTROLS HERE YET, DELIBERATELY. Phase 2 exists to prove the entire
 * realtime backbone — presence, heartbeat, ghost cleanup, reconnect snapshots,
 * rate limiting — before media complexity arrives. When a bug appears now, it
 * is unambiguously in the backbone rather than somewhere between three layers.
 *
 * Phase 3 adds the raise-hand button and speaker tiles to this screen.
 */

/** The closed palette. Names go over the wire; glyphs are a client concern. */
const REACTIONS: readonly { name: string; glyph: string; label: string }[] = [
  { name: 'heart', glyph: '💗', label: 'Heart' },
  { name: 'clap', glyph: '👏', label: 'Clap' },
  { name: 'laugh', glyph: '😄', label: 'Laugh' },
  { name: 'wow', glyph: '😮', label: 'Wow' },
  { name: 'fire', glyph: '🔥', label: 'Fire' },
  { name: 'wave', glyph: '👋', label: 'Wave' },
];

interface FloatingReaction {
  id: number;
  glyph: string;
  left: number;
}

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { status, profile } = useAuth();

  const roomId = typeof params.id === 'string' ? params.id : null;
  const {
    connection,
    state,
    messages,
    typingUserIds,
    error,
    sendMessage,
    sendTyping,
    sendReaction,
    leave,
  } = useRoom(status === 'authenticated' ? roomId : null);

  const [draft, setDraft] = useState('');
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingSentAt = useRef(0);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  // Keep the newest message in view — but only when the reader is already at
  // the bottom. Yanking someone back down while they scroll up to re-read
  // something is one of the most irritating things a chat UI can do.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 120) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    sendMessage(draft);
    setDraft('');
  };

  const onDraftChange = (value: string) => {
    setDraft(value);

    // Throttled client-side as well as server-side. The server drops excess
    // typing events silently, but there is no reason to spend a socket message
    // per keystroke to find that out.
    const now = Date.now();
    if (value.length > 0 && now - typingSentAt.current > 2_000) {
      typingSentAt.current = now;
      sendTyping();
    }
  };

  const react = (name: string, glyph: string) => {
    sendReaction(name);
    // Local flourish only. The broadcast animates for everyone via
    // `reaction:shown`; this is immediate feedback for the person who tapped.
    const id = Date.now() + Math.random();
    setFloating((current) => [...current, { id, glyph, left: 10 + Math.random() * 70 }]);
    setTimeout(() => setFloating((current) => current.filter((f) => f.id !== id)), 1600);
  };

  if (status !== 'authenticated' || roomId === null) {
    return (
      <main className="page page--centered">
        <div className="spinner" aria-label="Loading" />
      </main>
    );
  }

  const typingNames = (state?.members ?? [])
    .filter((m) => typingUserIds.includes(m.user.id) && m.user.id !== profile?.id)
    .map((m) => m.user.displayName);

  return (
    <main className="room">
      <header className="room__head">
        <button
          type="button"
          className="button--ghost"
          onClick={() => {
            leave();
            router.push('/rooms');
          }}
        >
          ← Leave
        </button>

        <div className="room__title-block">
          <h1 className="room__title">{state?.title ?? 'Joining…'}</h1>
          <span className="faint">{state === null ? '' : `${state.members.length} here`}</span>
        </div>

        <ConnectionPill state={connection} />
      </header>

      {error !== null && (
        <div className="notice notice--error" role="alert" style={{ margin: '0 1rem' }}>
          {error}
        </div>
      )}

      {/* Members: the whole point of the product is knowing who is present. */}
      <section className="room__members" aria-label="People in this room">
        {(state?.members ?? []).map((member) => {
          const avatar = avatarFor(member.user.avatarSeed, member.user.displayName);
          return (
            <div className="member" key={member.user.id} title={member.user.displayName}>
              <div
                className="avatar"
                style={{
                  width: '2.75rem',
                  height: '2.75rem',
                  background: avatar.background,
                  color: avatar.foreground,
                  fontSize: '0.85rem',
                }}
                aria-hidden="true"
              >
                {avatar.initials}
              </div>
              <span className="member__name">{member.user.displayName}</span>
              {member.role === 'host' && <span className="member__badge">host</span>}
              {member.mutedByHost && (
                <span className="member__badge member__badge--muted">muted</span>
              )}
            </div>
          );
        })}
      </section>

      {/* Chat */}
      <div className="room__chat" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="faint center" style={{ marginTop: '2rem' }}>
            No messages yet. Say hello.
          </p>
        ) : (
          messages.map((message) => (
            <div
              className={`bubble ${message.from.id === profile?.id ? 'bubble--own' : ''}`}
              key={message.id}
            >
              {message.from.id !== profile?.id && (
                <span className="bubble__author">{message.from.displayName}</span>
              )}
              <span className="bubble__text">{message.text}</span>
            </div>
          ))
        )}
      </div>

      {typingNames.length > 0 && (
        <p className="typing" aria-live="polite">
          {typingNames.slice(0, 2).join(' and ')}
          {typingNames.length > 2 ? ' and others' : ''} typing…
        </p>
      )}

      {/* Reactions */}
      <div className="reactions" aria-label="Send a reaction">
        {REACTIONS.map((reaction) => (
          <button
            key={reaction.name}
            type="button"
            className="reaction"
            onClick={() => react(reaction.name, reaction.glyph)}
            aria-label={reaction.label}
          >
            {reaction.glyph}
          </button>
        ))}
      </div>

      {/* Composer */}
      <form className="composer" onSubmit={submit}>
        <input
          className="input"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Say something…"
          maxLength={500}
          aria-label="Message"
          disabled={connection !== 'connected'}
        />
        <button
          className="button button--primary composer__send"
          type="submit"
          disabled={draft.trim().length === 0 || connection !== 'connected'}
        >
          Send
        </button>
      </form>

      {/* Floating reaction flourish */}
      <div className="floating-layer" aria-hidden="true">
        {floating.map((f) => (
          <span className="floating" key={f.id} style={{ left: `${f.left}%` }}>
            {f.glyph}
          </span>
        ))}
      </div>
    </main>
  );
}

/**
 * Connection state, shown honestly.
 *
 * A chat UI that looks identical whether or not it is connected is how someone
 * types three messages into a void. Reconnecting is a visible state.
 */
function ConnectionPill({ state }: { state: string }) {
  const label =
    state === 'connected'
      ? 'Live'
      : state === 'reconnecting'
        ? 'Reconnecting…'
        : state === 'failed'
          ? 'Disconnected'
          : 'Connecting…';

  return (
    <span className={`pill pill--${state}`} role="status">
      {label}
    </span>
  );
}
