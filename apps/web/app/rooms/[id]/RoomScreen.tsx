'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RoomFeeling, type RoomPulse } from '../../../lib/apiClient';
import type { RoomState } from '../../../lib/realtimeClient';
import { avatarFor } from '../../../lib/avatar';

/**
 * A room.
 *
 * FOUR ZONES, IN THIS ORDER, AND NOTHING ELSE
 * -------------------------------------------
 *   1. Where am I?          name, temperature, the room's promise
 *   2. What is happening?   who is speaking, who is listening, how it feels
 *   3. What can I do?       chat, hand, surprise, leave
 *   4. What happens to me?  one sentence about my own state
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No member count that ticks. No "3 hands raised". No join and leave lines in
 * the chat. No speaking timers, no activity meter, no percentages under the
 * pulse. Every one of those turns a place into a dashboard, and someone
 * watching numbers move is not listening to anybody.
 *
 * The rule this screen is built against: TELL ME ENOUGH TO FEEL SAFE, AND NOT
 * ENOUGH TO FEEL OBSERVED. The member list answers "who is here". It must never
 * accidentally answer "who wants attention" — which is why nothing here reads
 * `handRaised` for anyone but the host, and why the server does not send it.
 */

const CONTRACT: Record<string, { label: string; says: string }> = {
  quiet: { label: 'Quiet', says: 'Come listen. Conversation is optional.' },
  warm: { label: 'Warm', says: 'Friendly conversation. Everyone is welcome.' },
  deep: { label: 'Deep', says: 'Personal stories are welcome. No advice unless someone asks.' },
};

const FEELINGS: readonly { value: RoomFeeling; label: string }[] = [
  { value: 'calm', label: 'Calm' },
  { value: 'thoughtful', label: 'Thoughtful' },
  { value: 'playful', label: 'Playful' },
  { value: 'warm', label: 'Warm' },
  { value: 'heavy', label: 'Heavy' },
];

export interface RoomScreenProps {
  readonly state: RoomState;
  readonly temperature: string;
  readonly messages: readonly {
    id: string;
    from: { id: string; displayName: string };
    text: string;
  }[];
  readonly myUserId: string;
  /** Whether the SERVER's token permits audio. Never decided here. */
  readonly canPublish: boolean;
  readonly micEnabled: boolean;
  readonly onToggleMic: () => void;
  readonly onSend: (text: string) => void;
  readonly onRaiseHand: (raised: boolean) => void;
  readonly onApprove: (userId: string) => void;
  readonly onLeave: () => void;
}

export function RoomScreen(props: RoomScreenProps) {
  const { state, temperature, messages, myUserId } = props;

  const contract = CONTRACT[temperature] ?? CONTRACT.warm;
  const standing = state.yourStanding;

  /*
   * YOU ARE NOT IN THE LISTS.
   *
   * The lists answer "who else is here". Finding yourself in them means
   * scanning a group to work out where you stand, which is exactly the
   * dashboard reflex this room avoids — so instead a quiet "You" sits under
   * whichever group you belong to.
   *
   * Deliberately not a badge, not a highlight, not a brighter avatar. Marking
   * yourself loudly in a room full of other people is the thing this product
   * is least interested in doing.
   */
  const speakers = state.members.filter(
    (m) => (m.role === 'host' || m.role === 'speaker') && m.user.id !== myUserId,
  );
  const listeners = state.members.filter(
    (m) => m.role === 'listener' && m.user.id !== myUserId,
  );

  /*
   * From `selfRole` — the server's answer about THIS person — never by
   * searching the member list. That list is filtered by blocks and its
   * visibility rules differ from yours, and deriving a personal fact from a
   * collection is how the raise-hand button broke once already.
   */
  const iAmSpeaking = state.selfRole !== 'listener';

  const isHost = state.hostUserId === myUserId;

  /*
   * Who is waiting — HOST ONLY, and it comes from `raisedHands`, which the
   * server sends to nobody else. This is the one place in the product that
   * shows the queue, and it exists because approving is the host's job.
   */
  const waiting = isHost
    ? state.raisedHands
        .map((id) => state.members.find((m) => m.user.id === id))
        .filter((m): m is NonNullable<typeof m> => m !== undefined)
    : [];

  const [tab, setTab] = useState<'room' | 'chat'>('room');
  const [draft, setDraft] = useState('');
  const [pulse, setPulse] = useState<RoomPulse | null>(null);
  const [asking, setAsking] = useState(false);

  const bottom = useRef<HTMLDivElement | null>(null);

  /**
   * The pulse is fetched, not pushed.
   *
   * It changes slowly and nobody is waiting on it, so a subscription would mean
   * a stream of updates to a sentence that rarely differs. Once on entry is
   * enough; it refreshes when someone votes because their own answer changed.
   */
  useEffect(() => {
    let cancelled = false;
    void api
      .getRoomPulse(state.roomId)
      .then((result) => {
        if (!cancelled) setPulse(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state.roomId]);

  useEffect(() => {
    if (tab === 'chat') bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, tab]);

  const vote = useCallback(
    async (feeling: RoomFeeling) => {
      setAsking(false);
      try {
        await api.setRoomFeeling(state.roomId, feeling);
        setPulse(await api.getRoomPulse(state.roomId));
      } catch {
        // A mood that did not save is not worth interrupting anyone over.
      }
    },
    [state.roomId],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    props.onSend(text);
    setDraft('');
  }, [draft, props]);

  return (
    <main className="room">
      {/* ---------------------------------------------- 1. where am I? */}
      <header className="room-id">
        <h1 className="t-lg room-id__name">{state.title}</h1>
        <p className="room-id__temp">{contract.label}</p>
        <p className="room-id__says">{contract.says}</p>
      </header>

      <div className="room-body">
        {tab === 'room' ? (
          <>
            {/* ------------------------------------ 2. what's happening? */}
            <section aria-label="Speaking">
              <p className="t-over">Speaking</p>
              {speakers.length === 0 && !iAmSpeaking ? (
                <p className="t-sm">Nobody is speaking right now.</p>
              ) : (
                <ul className="speakers">
                  {speakers.map((member) => {
                    const style = avatarFor(member.user.avatarSeed, member.user.displayName);
                    return (
                      <li key={member.user.id} className="speaker">
                        <span
                          className="avatar"
                          style={{ background: style.background, color: style.foreground }}
                        >
                          {style.initials}
                        </span>
                        <span className="speaker__name">
                          {member.user.displayName}
                          {member.user.id === state.hostUserId && (
                            <span className="speaker__host"> · host</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {iAmSpeaking && <p className="room-me">You</p>}
            </section>

            <section aria-label="Listening">
              <p className="t-over">Listening</p>
              {/*
                Names, not a number. "18 listening" is a statistic; a handful of
                names and "others" is a room. Capped so the list never becomes
                something to scroll and count.
              */}
              <p className="t-sm room-listeners">{describeListeners(listeners)}</p>
              {!iAmSpeaking && <p className="room-me">You</p>}
            </section>

            {/*
              The host's queue. Deliberately plain: names and one action each,
              no waiting times, no "has been waiting 4 minutes" — a host
              deciding who speaks should not be nudged by a clock.
            */}
            {isHost && waiting.length > 0 && (
              <section aria-label="Waiting to speak">
                <p className="t-over">Hands up</p>
                <ul className="hands">
                  {waiting.map((member) => (
                    <li key={member.user.id}>
                      <span>{member.user.displayName}</span>
                      <button type="button" onClick={() => props.onApprove(member.user.id)}>
                        Bring in
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* The pulse, only when the server says it is safe to show. */}
            {pulse?.description !== null && pulse?.description !== undefined && (
              <p className="room-pulse">{pulse.description}</p>
            )}

            <button type="button" className="room-feel" onClick={() => setAsking((v) => !v)}>
              {pulse?.yours === null || pulse?.yours === undefined
                ? 'How does it feel in here?'
                : `You said it feels ${pulse.yours}.`}
            </button>

            {asking && (
              <div className="feelings" role="group" aria-label="How does the room feel">
                {FEELINGS.map((feeling) => (
                  <button
                    key={feeling.value}
                    type="button"
                    className={pulse?.yours === feeling.value ? 'chip chip--active' : 'chip'}
                    onClick={() => void vote(feeling.value)}
                  >
                    {feeling.label}
                  </button>
                ))}
                {/*
                  Said plainly, because someone about to answer honestly
                  deserves to know who sees it. Nobody does — not the host, not
                  the room, not us in any form anyone can read back.
                */}
                <p className="t-sm feelings__note">
                  Nobody is told what you chose. It only shows once enough people have said.
                </p>
              </div>
            )}
          </>
        ) : (
          <section className="room-chat" aria-label="Chat">
            {messages.length === 0 ? (
              <p className="t-sm">Nothing said yet.</p>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={message.from.id === myUserId ? 'bubble bubble--own' : 'bubble'}
                >
                  {message.from.id !== myUserId && (
                    <span className="bubble__author">{message.from.displayName}</span>
                  )}
                  <span className="bubble__text">{message.text}</span>
                </div>
              ))
            )}
            <div ref={bottom} />
          </section>
        )}
      </div>

      {/* ------------------------------------- 4. what happens to me? */}
      <p className="room-you">{sentenceFor(standing)}</p>

      {/* ----------------------------------------- 3. what can I do? */}
      {tab === 'chat' && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <input
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Say something…"
            maxLength={500}
            aria-label="Your message"
          />
          <button type="submit" className="button button--primary composer__send">
            Send
          </button>
        </form>
      )}

      {/*
        Secondary on purpose — a thin row of quiet text, not a toolbar. The room
        is the thing on this screen; these are how you act on it.
      */}
      <nav className="room-actions" aria-label="Room actions">
        <button type="button" onClick={() => setTab(tab === 'chat' ? 'room' : 'chat')}>
          💬 {tab === 'chat' ? 'Room' : 'Chat'}
        </button>

        {standing.state === 'speaking' ? (
          <>
            {props.canPublish && (
              <button type="button" onClick={props.onToggleMic}>
                {props.micEnabled ? '🎙 Mute' : '🔇 Unmute'}
              </button>
            )}
            <button type="button" onClick={() => props.onRaiseHand(false)}>
              Stop speaking
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => props.onRaiseHand(standing.state === 'listening')}
          >
            ✋ {standing.state === 'listening' ? 'Raise hand' : 'Cancel'}
          </button>
        )}

        <a href="/surprises">✨ Surprise</a>

        {/*
          "Leave quietly", and it does exactly that: no confirmation, no
          "are you sure", and nothing announced to the room. Someone who wants
          out should not have to justify it to a dialog.
        */}
        <button type="button" className="room-leave" onClick={props.onLeave}>
          Leave quietly
        </button>
      </nav>
    </main>
  );
}

/**
 * The user's own state, as ONE SENTENCE.
 *
 * Not a status panel with a badge and a legend. A person needs to know three
 * things — who can hear me, what is happening, what comes next — and a sentence
 * answers all three in the time it takes to read it.
 *
 * The listening line is the most important string in the product. Someone who
 * is not completely certain that nobody can hear them will not relax, and not
 * relaxing is the exact failure this whole room design exists to prevent.
 */
function sentenceFor(standing: RoomState['yourStanding']): string {
  switch (standing.state) {
    case 'speaking':
      return 'You are speaking. Everyone here can hear you.';
    case 'next':
      return 'You are next.';
    case 'waiting':
      return standing.wait === null
        ? `You are #${standing.position} in line.`
        : `You are #${standing.position} in line. ${standing.wait}`;
    case 'listening':
    default:
      return 'You are silent. You can hear the room and read along.';
  }
}

/**
 * Who is listening, in words.
 *
 * A few names and then "and others" — never a count. "18 listening" invites
 * someone to think about being one of eighteen; three names and a remainder
 * says the same thing about the room without making it a measurement.
 */
function describeListeners(listeners: RoomState['members']): string {
  const names = listeners.map((m) => m.user.displayName);

  if (names.length === 0) return 'Nobody else, yet.';

  const shown = names.slice(0, 3).join(' · ');
  return names.length > 3 ? `${shown} · others` : shown;
}

