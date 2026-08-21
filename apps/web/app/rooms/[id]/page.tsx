'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/AuthProvider';
import { useRoom } from '../../../lib/useRoom';
import { avatarFor } from '../../../lib/avatar';

/**
 * The room screen: member list, live chat, reactions.
 *
 * THE UI NEVER GRANTS ITSELF ANYTHING.
 *
 * Host controls are rendered when this client believes it is the host, and the
 * raise-hand button when it believes it is a listener. Both beliefs come from
 * the server's `room:state` snapshot, and both are re-checked server-side on
 * every action — so a modified client that renders the buttons anyway gains
 * nothing but a rejection.
 *
 * The microphone is the sharpest case: `canPublish` here reflects the token the
 * SERVER issued. Setting it true locally would not produce audio, because the
 * media server enforces the grant encoded in that token.
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
    speakers,
    voice,
    canPublish,
    micEnabled,
    raiseHand,
    approveSpeaker,
    removeSpeaker,
    muteUser,
    toggleMic,
    sendMessage,
    sendTyping,
    sendReaction,
    leave,
  } = useRoom(status === 'authenticated' ? roomId : null, profile?.id ?? null);

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

  const selfRole = state?.selfRole ?? 'listener';
  const isHost = selfRole === 'host';
  // Who is audible RIGHT NOW, from the media layer rather than from roles.
  const speakingIds = new Set(speakers.filter((p) => p.isSpeaking).map((p) => p.identity));
  const handRaisedByMe = (state?.members ?? []).some(
    (m) => m.user.id === profile?.id && m.handRaised,
  );

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
              {member.role === 'speaker' && (
                <span className="member__badge member__badge--speaker">speaking</span>
              )}
              {member.handRaised && <span className="member__badge">✋</span>}
              {member.mutedByHost && (
                <span className="member__badge member__badge--muted">muted</span>
              )}

              {/* Host controls. Rendered on belief, ENFORCED on the server —
                  every one of these is re-checked against live presence. */}
              {isHost && member.user.id !== profile?.id && (
                <div className="member__actions">
                  {member.role === 'listener' ? (
                    <button
                      type="button"
                      className="mini-button"
                      onClick={() => approveSpeaker(member.user.id)}
                      title="Invite to speak"
                    >
                      invite
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mini-button"
                      onClick={() => removeSpeaker(member.user.id)}
                      title="Take the floor back"
                    >
                      remove
                    </button>
                  )}
                  <button
                    type="button"
                    className="mini-button"
                    onClick={() => muteUser(member.user.id, !member.mutedByHost)}
                    title={member.mutedByHost ? 'Unmute' : 'Mute'}
                  >
                    {member.mutedByHost ? 'unmute' : 'mute'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* The stage: who currently has the floor, and who is talking. */}
      <section className="stage" aria-label="On stage">
        {(state?.members ?? [])
          .filter((m) => m.role !== 'listener')
          .map((member) => {
            const avatar = avatarFor(member.user.avatarSeed, member.user.displayName);
            const talking = speakingIds.has(member.user.id) && !member.mutedByHost;

            return (
              <div className={`tile ${talking ? 'tile--talking' : ''}`} key={member.user.id}>
                <div
                  className="avatar"
                  style={{
                    width: '3.25rem',
                    height: '3.25rem',
                    background: avatar.background,
                    color: avatar.foreground,
                    fontSize: '0.95rem',
                  }}
                  aria-hidden="true"
                >
                  {avatar.initials}
                </div>
                <span className="tile__name">{member.user.displayName}</span>
                {member.mutedByHost && <span className="tile__muted">muted</span>}
              </div>
            );
          })}

        {(state?.members ?? []).filter((m) => m.role !== 'listener').length === 0 && (
          <p className="faint" style={{ margin: '0.5rem auto' }}>
            Nobody has the floor yet.
          </p>
        )}
      </section>

      {/* Voice controls. What is shown depends on what the SERVER granted. */}
      <div className="voice-bar">
        <span className={`pill pill--${voice === 'connected' ? 'connected' : 'connecting'}`}>
          {voice === 'connected' ? 'Audio on' : voice === 'disconnected' ? 'No audio' : 'Audio…'}
        </span>

        {canPublish ? (
          <button
            type="button"
            className={`button button--secondary voice-bar__mic ${micEnabled ? 'voice-bar__mic--live' : ''}`}
            onClick={toggleMic}
          >
            {micEnabled ? '🎙 Mic on' : '🔇 Mic off'}
          </button>
        ) : (
          <button
            type="button"
            className="button button--secondary voice-bar__mic"
            onClick={() => raiseHand(!handRaisedByMe)}
          >
            {handRaisedByMe ? 'Lower hand' : '✋ Raise hand'}
          </button>
        )}
      </div>

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
