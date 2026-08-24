'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type HomeRoom, type HomeView, type Intent } from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';

/**
 * Home — a calm dashboard, not a feed.
 *
 * THE FIVE-SECOND TEST
 * --------------------
 * Someone opening this should understand the product before they read
 * anything carefully: *I say what I want tonight, I see a room that suits it,
 * I can go in without speaking.* Everything on this screen serves that
 * sentence, and anything that does not is not here.
 *
 * So: no counts that grow, no infinite scroll, no notifications, nothing to
 * refresh for. The list ends. The screen's job is to get someone into a room
 * and then be finished.
 *
 * THE RULE THIS SCREEN FOLLOWS MOST CAREFULLY
 * -------------------------------------------
 * It never explains its own ranking. The server puts a matching room first,
 * and the UI shows a list — no "matched your intent" badge, no "recommended
 * because", no ordering explanation. A recommendation that announces itself
 * stops feeling like a suggestion and starts feeling like a system, and the
 * moment someone can see the mechanism they start playing it.
 *
 * `matchesIntent` is deliberately never rendered.
 */

/**
 * The intents, in the order they are offered.
 *
 * Ordered from least to most demanding of the person. "Listen" first because
 * it is the honest default for this product, and "Just be here" last because
 * it is the one that asks nothing at all — someone who scans the row and finds
 * nothing that fits has, at the end, an option that requires nothing of them.
 */
const INTENTS: readonly { value: Intent; glyph: string; label: string }[] = [
  { value: 'listen', glyph: '👂', label: 'Listen' },
  { value: 'talk', glyph: '💬', label: 'Talk' },
  { value: 'think', glyph: '🧠', label: 'Think' },
  { value: 'connect', glyph: '❤️', label: 'Connect' },
  { value: 'be', glyph: '🌙', label: 'Just be here' },
];

const GREETING: Record<HomeView['greeting'], string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  // Not "good night". Someone awake at 3am is not going to bed, and greeting
  // them as though they were is the app failing to notice where it is.
  late: 'Still up',
};

export default function HomePage() {
  const router = useRouter();
  const { status } = useAuth();

  const [view, setView] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  const load = useCallback(async () => {
    try {
      setView(await api.getHome());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    void load();
  }, [status, load]);

  /**
   * Choosing an intent re-fetches, because the ROOMS change.
   *
   * Optimistically painting the selection first means the button responds
   * instantly and the list settles a moment later — which is the right order
   * on a slow connection, where waiting for a round trip before acknowledging
   * a tap reads as the tap not having registered.
   */
  const choose = useCallback(
    async (intent: Intent) => {
      const next = view?.intent === intent ? null : intent;
      setPending(intent);
      setView((current) => (current === null ? current : { ...current, intent: next }));

      try {
        if (next === null) await api.clearIntent();
        else await api.setIntent(next);
        await load();
      } catch {
        // Put it back. A selection that silently did not take is worse than
        // one that visibly refused.
        await load();
      } finally {
        setPending(null);
      }
    },
    [view?.intent, load],
  );

  if (status === 'loading' || view === null) {
    return (
      <main className="page">
        <p className="t-sm">…</p>
      </main>
    );
  }

  const rooms = [...view.live, ...view.quiet];

  return (
    <main className="page home">
      <header className="home-head">
        <p className="t-sm">
          {GREETING[view.greeting]}, {view.displayName}.
        </p>
        <h1 className="t-lg">What do you want tonight?</h1>
      </header>

      <div className="intents" role="group" aria-label="What do you want tonight">
        {INTENTS.map((intent) => {
          const on = view.intent === intent.value;
          return (
            <button
              key={intent.value}
              type="button"
              className={on ? 'intent intent--on' : 'intent'}
              aria-pressed={on}
              disabled={pending !== null}
              onClick={() => void choose(intent.value)}
            >
              <span className="intent__glyph" aria-hidden="true">
                {intent.glyph}
              </span>
              <span>{intent.label}</span>
            </button>
          );
        })}
      </div>

      {error !== null && <p className="notice notice--error">{error}</p>}

      <section aria-label="Rooms">
        <p className="t-over">{view.intent === null ? 'People are here now' : 'Rooms for you'}</p>

        {rooms.length === 0 ? (
          <div className="card empty">
            <h2 className="t-md">No rooms open yet</h2>
            <p className="t-sm">
              Nobody has started one tonight. You could be the first — a room with one person in it
              is still a room.
            </p>
            <Link href="/rooms" className="button button--secondary">
              Start a room
            </Link>
          </div>
        ) : (
          <ul className="roomlist">
            {rooms.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
          </ul>
        )}
      </section>

      {view.nights > 0 && (
        <p className="t-sm home-nights">
          {view.nights === 1
            ? 'First night. Your place is here whenever you want it.'
            : `${view.nights} nights you have shown up.`}
        </p>
      )}
    </main>
  );
}

/**
 * The contract each temperature carries.
 *
 * The WORDS, not the label. "Deep" alone means nothing to someone deciding
 * whether to walk in; *"no advice unless someone asks"* is a promise they can
 * hold the room to — and it is the single most useful thing on this card.
 */
const CONTRACT: Record<HomeRoom['temperature'], { label: string; says: string }> = {
  quiet: { label: 'Quiet', says: 'Come listen. Conversation is optional.' },
  warm: { label: 'Warm', says: 'Friendly conversation. Everyone is welcome.' },
  deep: { label: 'Deep', says: 'Personal stories are welcome. No advice unless someone asks.' },
};

function RoomCard({ room }: { room: HomeRoom }) {
  const contract = CONTRACT[room.temperature];
  const anyone = room.listening + room.speaking > 0;

  return (
    <li>
      <Link href={`/rooms/${room.id}`} className="roomcard">
        <div className="roomcard__top">
          <span className="t-md">{room.title}</span>
          <span className="roomcard__temp">{contract.label}</span>
        </div>

        {/*
          Occupancy, and only occupancy. No trending, no "popular", no arrow
          showing it growing — this is the one number on the screen and it is
          here to answer "is anyone in there", not to compete.
        */}
        <p className="t-sm roomcard__who">
          {anyone ? (
            <>
              <i className="present-dot" aria-hidden="true" />
              <span className="present">
                {room.listening} listening
                {room.speaking > 0 && ` · ${room.speaking} speaking`}
              </span>
            </>
          ) : (
            'Nobody here yet'
          )}
        </p>

        <p className="t-sm roomcard__says">{contract.says}</p>

        {/*
          "Join quietly" rather than "Join". Three words that say the whole
          product: you are going in, and you are not expected to speak.
        */}
        <span className="roomcard__go">Join quietly →</span>
      </Link>
    </li>
  );
}
