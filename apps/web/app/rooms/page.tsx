'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, type RoomSummary } from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';

/**
 * The room list — the real home screen.
 *
 * WHY IT POLLS RATHER THAN SUBSCRIBING
 * ------------------------------------
 * Occupancy counts change constantly, and pushing every change to every user
 * browsing the list would mean broadcasting each join and leave to people who
 * are not in that room. That is a lot of traffic to keep a number accurate that
 * nobody is reading precisely.
 *
 * A slow poll is the honest trade: the list is a few seconds stale, which for
 * "roughly how busy is this room" is indistinguishable from live, and it costs
 * one request instead of a fan-out.
 *
 * The socket is reserved for rooms you are actually IN, where staleness is
 * immediately visible.
 */
const REFRESH_INTERVAL_MS = 10_000;

const CATEGORIES = [
  { value: null, label: 'All' },
  { value: 'late_night', label: 'Late night' },
  { value: 'study', label: 'Study' },
  { value: 'casual', label: 'Casual' },
  { value: 'support', label: 'Support' },
  { value: 'music', label: 'Music' },
] as const;

export default function RoomsPage() {
  const router = useRouter();
  const { status, profile } = useAuth();

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  const load = useCallback(async () => {
    try {
      const result = await api.listRooms(category ?? undefined);
      setRooms(result.rooms);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load rooms.');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    if (status !== 'authenticated') return;

    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  if (status !== 'authenticated') {
    return (
      <main className="page page--centered">
        <div className="spinner" aria-label="Loading" />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="stack">
        <header className="list-head">
          <div>
            <div className="brand__mark" style={{ fontSize: '1.25rem' }}>
              LOVERLINK
            </div>
            <p className="faint" style={{ margin: '0.2rem 0 0' }}>
              Drop in. Listen first.
            </p>
          </div>
          <Link href="/profile" className="button--ghost" style={{ textDecoration: 'none' }}>
            {profile?.displayName ?? 'You'}
          </Link>
        </header>

        {/*
          The two screens that only make sense once you have been in a room.
          They live here rather than in a bottom tab bar because at this stage
          the room list IS the home screen, and a permanent nav bar for three
          destinations costs more vertical space than it earns.
        */}
        <nav className="home-nav" aria-label="Elsewhere">
          <Link href="/connections">Connections</Link>
          <Link href="/surprises">Surprises</Link>
        </nav>

        <nav className="chips" aria-label="Filter by category">
          {CATEGORIES.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`chip ${category === option.value ? 'chip--active' : ''}`}
              onClick={() => setCategory(option.value)}
              aria-pressed={category === option.value}
            >
              {option.label}
            </button>
          ))}
        </nav>

        {error !== null && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="spinner" aria-label="Loading rooms" />
        ) : rooms.length === 0 ? (
          // The empty state is load-bearing on a social product: a blank screen
          // at launch reads as broken rather than quiet.
          <div className="card center">
            <p style={{ marginTop: 0 }}>Nobody is talking yet.</p>
            <p className="muted">Start a room and see who turns up.</p>
          </div>
        ) : (
          <ul className="room-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <Link href={`/rooms/${room.id}`} className="room-card">
                  <div className="room-card__body">
                    <span className="room-card__category">{labelFor(room.category)}</span>
                    <h2 className="room-card__title">{room.title}</h2>
                  </div>
                  <div className="room-card__count">
                    <span className={room.memberCount ? 'live-dot live-dot--on' : 'live-dot'} />
                    {room.memberCount ?? 0}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="button button--primary"
          style={{ marginTop: '1.5rem' }}
          onClick={() => setCreating(true)}
        >
          Start a room
        </button>
      </div>

      {creating && (
        <CreateRoomDialog
          onClose={() => setCreating(false)}
          onCreated={(room) => router.push(`/rooms/${room.id}`)}
        />
      )}
    </main>
  );
}

function CreateRoomDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (room: RoomSummary) => void;
}) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('casual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createRoom({ title, category }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that room.');
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <form
        className="sheet"
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        aria-label="Start a room"
      >
        <h2 className="card__title">Start a room</h2>

        {error !== null && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="field__label">What is it about?</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Late night thoughts"
            maxLength={60}
            required
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="field">
          <span className="field__label">Category</span>
          <select
            className="input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy}
          >
            {CATEGORIES.filter((c) => c.value !== null).map((option) => (
              <option key={option.value} value={option.value as string}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <p className="faint" style={{ marginTop: 0 }}>
          You will be the host. Everyone joins as a listener until you invite them to speak.
        </p>

        <button
          className="button button--primary"
          type="submit"
          disabled={busy || title.trim().length < 3}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
      </form>
    </div>
  );
}

function labelFor(category: string): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? category;
}
