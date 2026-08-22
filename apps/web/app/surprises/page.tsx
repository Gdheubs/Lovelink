'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  type ReceivedSurprise,
  type RevealedSurprise,
  type SentSurprise,
  type SurpriseMood,
  type SurpriseTheme,
} from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';

/**
 * Surprises — the icebreaker, and the lowest rung of the ladder.
 *
 * WHY A CODE AND NOT A "SEND TO" FIELD
 * ------------------------------------
 * This is the one thing here you can hand to someone you have only just met,
 * and the point is that neither of you exposes a way to be contacted. You spoke
 * in a room, you read out six characters, and that is the whole exchange. A
 * recipient picker would require you to already have the relationship this is
 * meant to start.
 *
 * THE MOOD BELONGS TO THE PERSON OPENING IT
 * -----------------------------------------
 * The sender chose the theme — what they wanted to say. The recipient chooses
 * the mood at the moment they open it, and that is what selects the words,
 * because the sender wrote this hours or days ago and cannot know how the
 * reader is feeling now. It is the whole idea, so the opening flow asks before
 * it reveals anything.
 */

const THEMES: readonly { value: SurpriseTheme; label: string; blurb: string }[] = [
  { value: 'thinking_of_you', label: 'Thinking of you', blurb: 'No occasion, no ask.' },
  { value: 'love', label: 'Love', blurb: 'The plain version.' },
  { value: 'miss', label: 'Miss you', blurb: 'For the gap where they usually are.' },
  { value: 'sorry', label: 'Sorry', blurb: 'A real one, not a convenient one.' },
  { value: 'congrats', label: 'Well done', blurb: 'They earned it.' },
];

const MOODS: readonly { value: SurpriseMood; label: string }[] = [
  { value: 'happy', label: 'Good, actually' },
  { value: 'soft', label: 'Tender' },
  { value: 'meh', label: 'Grey' },
  { value: 'tired', label: 'Worn out' },
  { value: 'sad', label: 'Low' },
  { value: 'angry', label: 'Angry' },
];

type Tab = 'open' | 'send' | 'mine';

export default function SurprisesPage() {
  const router = useRouter();
  const { status } = useAuth();
  const [tab, setTab] = useState<Tab>('open');

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  if (status === 'loading') {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-head">
        <h1>Surprises</h1>
        <Link href="/rooms" className="button button--ghost">
          Rooms
        </Link>
      </header>

      <nav className="chips" aria-label="Surprises">
        {(
          [
            ['open', 'Open one'],
            ['send', 'Send one'],
            ['mine', 'Yours'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? 'chip chip--active' : 'chip'}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'open' && <OpenSurprise />}
      {tab === 'send' && <SendSurprise />}
      {tab === 'mine' && <MySurprises />}
    </main>
  );
}

// ---------------------------------------------------------------------------

function OpenSurprise() {
  const [code, setCode] = useState('');
  const [mood, setMood] = useState<SurpriseMood | null>(null);
  const [revealed, setRevealed] = useState<RevealedSurprise | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async () => {
    if (mood === null || code.trim().length === 0 || busy) return;

    setBusy(true);
    try {
      setRevealed(await api.redeemSurprise({ code: code.trim(), mood }));
      setError(null);
    } catch (caught) {
      /*
       * One message for every failure, on purpose.
       *
       * The server refuses a wrong code, an expired one and one somebody else
       * already opened with the same 404, so that guessing tells an attacker
       * nothing. Inventing a more specific message here would hand back exactly
       * the signal the server withheld.
       */
      setError(
        caught instanceof Error && caught.message.includes('already')
          ? 'That surprise has already been opened.'
          : 'We could not find a surprise with that code. Check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [code, mood, busy]);

  if (revealed !== null) {
    return <Reveal surprise={revealed} onDone={() => {
      setRevealed(null);
      setCode('');
      setMood(null);
    }} />;
  }

  return (
    <section className="surprise-open">
      <label className="field">
        <span className="field__label">Your code</span>
        <input
          className="input input--code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          // Spaces, dashes and case are all normalised server-side, because
          // people read these off a screen or hear them out loud.
          placeholder="LOVE-7K2M"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
        />
      </label>

      <fieldset className="mood-picker">
        <legend>Before you open it — how are you, honestly?</legend>
        <p className="faint">
          Whoever sent this could not know how today has gone. This is what lets it meet you where
          you actually are.
        </p>
        <div className="mood-grid">
          {MOODS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={mood === option.value ? 'chip chip--active' : 'chip'}
              aria-pressed={mood === option.value}
              onClick={() => setMood(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      {error !== null && <p className="notice notice--error">{error}</p>}

      <button
        type="button"
        className="button button--primary"
        disabled={code.trim().length === 0 || mood === null || busy}
        onClick={() => void open()}
      >
        {busy ? 'Opening…' : 'Open it'}
      </button>
    </section>
  );
}

function Reveal({ surprise, onDone }: { surprise: RevealedSurprise; onDone: () => void }) {
  const [tasks, setTasks] = useState(surprise.tasks);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);

  const toggle = useCallback(
    async (index: number, done: boolean) => {
      setBusyIndex(index);
      try {
        const updated = await api.toggleSurpriseTask(surprise.id, index, done);
        setTasks(updated.tasks);
      } catch {
        // Leave the checkbox as it was. A tick that silently did not save is
        // worse than one that visibly did not move.
      } finally {
        setBusyIndex(null);
      }
    },
    [surprise.id],
  );

  return (
    <section className="reveal">
      <p className="reveal-from">From {surprise.from.displayName}</p>
      <p className="reveal-message">{surprise.reveal}</p>

      {surprise.personalMessage.length > 0 && (
        <blockquote className="reveal-personal">{surprise.personalMessage}</blockquote>
      )}

      {tasks.length > 0 && (
        <div className="reveal-tasks">
          <h3>They left you these</h3>
          <ul>
            {tasks.map((task, index) => (
              <li key={`${task.text}-${index}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={busyIndex === index}
                    onChange={(event) => void toggle(index, event.target.checked)}
                  />
                  <span className={task.done ? 'done' : undefined}>{task.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" className="button button--secondary" onClick={onDone}>
        Done
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function SendSurprise() {
  const [theme, setTheme] = useState<SurpriseTheme>('thinking_of_you');
  const [message, setMessage] = useState('');
  const [tasks, setTasks] = useState<string[]>(['']);
  const [created, setCreated] = useState<{ code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCallback(async () => {
    if (message.trim().length === 0 || busy) return;

    setBusy(true);
    try {
      const result = await api.createSurprise({
        theme,
        message: message.trim(),
        tasks: tasks.map((task) => task.trim()).filter((task) => task.length > 0),
      });
      setCreated({ code: result.code });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not send.');
    } finally {
      setBusy(false);
    }
  }, [theme, message, tasks, busy]);

  if (created !== null) {
    return (
      <section className="surprise-created">
        <h2>Ready to hand over</h2>
        <p className="code-display">{created.code}</p>
        <p className="faint">
          Read it out, or send it however you like. Whoever opens it first is the one who gets it —
          so give it to one person.
        </p>

        <div className="row">
          <button
            type="button"
            className="button button--secondary composer__send"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(created.code)
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
          <button
            type="button"
            className="button button--primary composer__send"
            onClick={() => {
              setCreated(null);
              setMessage('');
              setTasks(['']);
              setCopied(false);
            }}
          >
            Send another
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="surprise-send">
      <fieldset>
        <legend>What are you trying to say?</legend>
        <div className="theme-grid">
          {THEMES.map((option) => (
            <button
              key={option.value}
              type="button"
              className={theme === option.value ? 'card theme card--selected' : 'card theme'}
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              <span className="theme-label">{option.label}</span>
              <span className="theme-blurb">{option.blurb}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span className="field__label">In your own words</span>
        <textarea
          className="input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="Good talking to you tonight."
        />
        <span className="faint counter">{message.length}/1000</span>
      </label>

      <fieldset className="tasks-field">
        <legend>Small things to leave them (optional)</legend>
        {tasks.map((task, index) => (
          <input
            className="input"
            key={index}
            value={task}
            maxLength={120}
            placeholder="Drink some water"
            onChange={(event) => {
              const next = [...tasks];
              next[index] = event.target.value;
              // Grow by one as the last row is filled, up to the server's
              // limit of five. No add button to hunt for.
              if (index === next.length - 1 && next.length < 5 && event.target.value.length > 0) {
                next.push('');
              }
              setTasks(next);
            }}
          />
        ))}
      </fieldset>

      {error !== null && <p className="notice notice--error">{error}</p>}

      <button
        type="button"
        className="button button--primary"
        disabled={message.trim().length === 0 || busy}
        onClick={() => void create()}
      >
        {busy ? 'Making it…' : 'Make the code'}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function MySurprises() {
  const [sent, setSent] = useState<SentSurprise[]>([]);
  const [received, setReceived] = useState<ReceivedSurprise[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await api.listMySurprises();
        if (cancelled) return;
        setSent(result.sent);
        setReceived(result.received);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="muted">Loading…</p>;

  if (sent.length === 0 && received.length === 0) {
    return (
      <section className="card empty">
        <h2>Nothing yet</h2>
        <p>
          A surprise is something you can hand to someone you have just met, without either of you
          giving out a way to be contacted.
        </p>
      </section>
    );
  }

  return (
    <>
      {received.length > 0 && (
        <section aria-label="Surprises you were given">
          <h2 className="list-head">Given to you</h2>
          <ul className="surprise-list">
            {received.map((surprise) => (
              <li key={surprise.id}>
                <span className="surprise-theme">{labelFor(surprise.theme)}</span>
                <span className="surprise-message">{surprise.message}</span>
                {surprise.tasks.length > 0 && (
                  <span className="surprise-progress">
                    {surprise.tasks.filter((task) => task.done).length}/{surprise.tasks.length} done
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {sent.length > 0 && (
        <section aria-label="Surprises you sent">
          <h2 className="list-head">You sent</h2>
          <ul className="surprise-list">
            {sent.map((surprise) => (
              <li key={surprise.id}>
                <span className="surprise-theme">{labelFor(surprise.theme)}</span>
                <span className="surprise-message">{surprise.message}</span>
                <span className={surprise.opened ? 'surprise-opened' : 'surprise-waiting'}>
                  {/*
                    Whether it was opened, and nothing more. How the reader felt
                    was a private disclosure made to choose a message, not a
                    message to the sender — the server does not return it.
                  */}
                  {surprise.opened ? 'Opened' : `Unopened · ${surprise.code}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function labelFor(theme: SurpriseTheme): string {
  return THEMES.find((option) => option.value === theme)?.label ?? 'Surprise';
}
