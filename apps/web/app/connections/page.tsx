'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  type Connection,
  type ConnectionsView,
  type DmMessage,
  type PublicProfile,
} from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';
import { useSignalling } from '../../lib/SignallingProvider';
import { realtime } from '../../lib/realtimeClient';
import { avatarFor } from '../../lib/avatar';

/**
 * Connections — the answer to "who did I meet?"
 *
 * WHY THIS SCREEN CARRIES MORE WEIGHT THAN IT LOOKS LIKE
 * ------------------------------------------------------
 * In a drop-in voice product that question is genuinely hard. You talked to
 * someone for twenty minutes and learned nothing you could search for: no
 * handle, no number, no last name. This list is the ONLY durable record that
 * the conversation happened, which is why it leads with the person and not with
 * the last message.
 *
 * INCOMING REQUESTS SIT ABOVE THE LIST, NOT IN IT
 * -----------------------------------------------
 * They demand a decision. Mixed into the same list they either get buried under
 * active threads or turn the whole screen into a nag. Separated, they are
 * finite, obvious, and easy to clear.
 *
 * WHAT YOU WILL NOT FIND HERE: requests you SENT. The server does not return
 * them and this screen does not ask. Seeing "waiting for a reply" tells you
 * something you are not entitled to know and invites a second ask — which is
 * the pressure the request/accept design exists to prevent.
 */
export default function ConnectionsPage() {
  const router = useRouter();
  const { status, profile } = useAuth();
  const { placeCall, activeCall, connected } = useSignalling();

  const [view, setView] = useState<ConnectionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyWith, setBusyWith] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<Connection | null>(null);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  const load = useCallback(async () => {
    try {
      setView(await api.listConnections());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your connections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    void load();
  }, [status, load]);

  /**
   * Reload when the ladder moves.
   *
   * These events change what this screen should show — a new request appears, a
   * conversation opens — and reloading is both simpler and more correct than
   * patching the list locally, because the server also recomputes which buttons
   * are allowed.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;

    const unsubscribers = [
      realtime.on('dm:requested', () => void load()),
      realtime.on('dm:opened', () => void load()),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [status, load]);

  const respond = useCallback(
    async (userId: string, action: 'accept' | 'decline') => {
      setBusyWith(userId);
      try {
        if (action === 'accept') await api.acceptDm(userId);
        else await api.declineDm(userId);
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That did not work.');
      } finally {
        setBusyWith(null);
      }
    },
    [load],
  );

  if (status === 'loading' || (loading && view === null)) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (openThread !== null && profile !== null) {
    return (
      <DmThread
        connection={openThread}
        myUserId={profile.id}
        onBack={() => {
          setOpenThread(null);
          void load();
        }}
      />
    );
  }

  const requests = view?.incomingRequests ?? [];
  const connections = view?.connections ?? [];

  return (
    <main className="page">
      <header className="page-head">
        <h1>Connections</h1>
        <Link href="/rooms" className="button button--ghost">
          Rooms
        </Link>
      </header>

      {error !== null && <p className="notice notice--error">{error}</p>}

      {requests.length > 0 && (
        <section className="requests" aria-label="Requests waiting for you">
          <h2 className="list-head">Waiting for you</h2>
          {requests.map((request) => (
            <div key={request.user.id} className="request-row">
              <Person connection={request} />
              <div className="request-actions">
                <button
                  type="button"
                  className="button button--secondary composer__send"
                  disabled={busyWith === request.user.id}
                  onClick={() => void respond(request.user.id, 'decline')}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="button button--primary composer__send"
                  disabled={busyWith === request.user.id}
                  onClick={() => void respond(request.user.id, 'accept')}
                >
                  Accept
                </button>
              </div>
            </div>
          ))}
          <p className="faint">
            Declining is silent — they are not told, and they can ask again another time.
          </p>
        </section>
      )}

      {connections.length === 0 ? (
        /*
         * The empty state is the FIRST thing most people will see here, and it
         * has one job: explain that connections are earned in rooms, not
         * searched for. A bare "nothing here" would read as a broken feature.
         */
        <section className="card empty">
          <h2>No connections yet</h2>
          <p>
            You can message someone once you have shared a room with them — that shared time is
            what unlocks it. Drop into a room and listen for a while.
          </p>
          <Link href="/rooms" className="button button--primary">
            Find a room
          </Link>
        </section>
      ) : (
        <section aria-label="Your connections">
          <h2 className="list-head">People you have met</h2>
          <ul className="connection-list">
            {connections.map((connection) => (
              <li key={connection.user.id} className="connection-row">
                <button
                  type="button"
                  className="connection-open"
                  onClick={() => setOpenThread(connection)}
                >
                  <Person connection={connection} />
                </button>

                <button
                  type="button"
                  className="call-button"
                  // Two separate reasons to be unavailable, both honest: the
                  // server says this pair may not call, or this device is
                  // already busy. Neither is authorization — the server
                  // re-checks when the invite actually arrives.
                  disabled={!connection.can.canCall || !connected || activeCall !== null}
                  onClick={() => placeCall(connection.user.id, connection.user.displayName)}
                  aria-label={`Call ${connection.user.displayName}`}
                >
                  Call
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/** Fall back to the least privileged tier for anything unrecognised. */
function asTier(value: string): PublicProfile['tier'] {
  return value === 'newcomer' || value === 'regular' || value === 'trusted' || value === 'restricted'
    ? value
    : 'newcomer';
}

function Person({ connection }: { connection: Connection }) {
  const style = avatarFor(connection.user.avatarSeed, connection.user.displayName);

  return (
    <span className="person">
      <span className="avatar" style={{ background: style.background, color: style.foreground }}>
        {style.initials}
      </span>
      <span className="person-text">
        <span className="person-name">{connection.user.displayName}</span>
        <span className="person-sub">
          {connection.state === 'call_open' ? 'On a call' : 'Open conversation'}
        </span>
      </span>
    </span>
  );
}

/**
 * One conversation.
 *
 * WHY IT LOADS HISTORY OVER HTTP AND LISTENS OVER THE SOCKET
 * ----------------------------------------------------------
 * They are answering different questions. HTTP answers "what was said before I
 * opened this", which is a paginated read of durable rows. The socket answers
 * "what is being said now". Trying to serve both from one channel means either
 * replaying history through the socket on every open, or polling for messages
 * that the server already knows how to push.
 */
function DmThread({
  connection,
  myUserId,
  onBack,
}: {
  connection: Connection;
  myUserId: string;
  onBack: () => void;
}) {
  const { placeCall, activeCall, connected } = useSignalling();

  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const page = await api.readDmThread(connection.user.id, { limit: 50 });
        if (cancelled) return;
        // The server returns newest first, because that is what pagination
        // needs. Reading order is the other way round.
        setMessages([...page.messages].reverse());
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not load this conversation.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection.user.id]);

  useEffect(() => {
    const unsubscribe = realtime.on('dm:message', (payload) => {
      // The socket carries every DM this user is party to, not just this
      // thread. Filtering to the two participants is what keeps another
      // conversation from appearing in this one.
      const isThisThread =
        payload.from.id === connection.user.id || payload.from.id === myUserId;
      if (!isThisThread) return;

      // The socket's profile type widens `tier` to a plain string on purpose —
      // the frontend is a separate deployable and must survive a server that
      // adds a tier it has never heard of. Narrowing happens here, at the one
      // boundary where an unknown value can be given a sane fallback instead
      // of crashing a render.
      const message: DmMessage = {
        id: payload.id,
        roomId: payload.roomId,
        from: {
          id: payload.from.id,
          displayName: payload.from.displayName,
          avatarSeed: payload.from.avatarSeed,
          tier: asTier(payload.from.tier),
        },
        text: payload.text,
        sentAt: payload.sentAt,
      };

      setMessages((current) =>
        // The sender's own echo can race the POST response. Keying on id makes
        // the duplicate impossible rather than unlikely.
        current.some((existing) => existing.id === message.id) ? current : [...current, message],
      );
    });

    return unsubscribe;
  }, [connection.user.id, myUserId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;

    setSending(true);
    try {
      const sent = await api.sendDm(connection.user.id, text);
      setDraft('');
      setMessages((current) =>
        current.some((message) => message.id === sent.id) ? current : [...current, sent],
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That message did not send.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, connection.user.id]);

  return (
    <main className="page thread-page">
      <header className="thread-head">
        <button type="button" className="button button--ghost" onClick={onBack}>
          ← Back
        </button>
        <span className="thread-title">{connection.user.displayName}</span>
        <button
          type="button"
          className="call-button"
          disabled={!connection.can.canCall || !connected || activeCall !== null}
          onClick={() => placeCall(connection.user.id, connection.user.displayName)}
        >
          Call
        </button>
      </header>

      {error !== null && <p className="notice notice--error">{error}</p>}

      <div className="thread-body">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="muted center">
            You met in a room. Say hello — there is no history here yet.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={message.from.id === myUserId ? 'bubble bubble--own' : 'bubble'}
            >
              <span className="bubble__text">{message.text}</span>
              <time className="bubble__time" dateTime={message.sentAt}>
                {new Date(message.sentAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Message ${connection.user.displayName}`}
          maxLength={500}
          aria-label="Your message"
        />
        <button type="submit" className="button button--primary composer__send" disabled={draft.trim().length === 0 || sending}>
          Send
        </button>
      </form>
    </main>
  );
}
