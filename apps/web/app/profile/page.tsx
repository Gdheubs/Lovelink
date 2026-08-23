'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';
import { AppSettings } from './AppSettings';
import { avatarFor, TIER_LABEL } from '../../lib/avatar';

/**
 * The profile screen.
 *
 * WHY THE TRUST LEDGER IS ON SCREEN
 * ---------------------------------
 * The whole reason `trust_events` is append-only is so that a user can be told
 * WHY their account stands where it does. Keeping that server-side and showing
 * only a number would waste the design: "your trust score is 12" is not an
 * explanation, and a user who cannot send a DM deserves a dated list rather
 * than a shrug.
 *
 * Showing it also creates useful pressure on us — a reason string that would
 * embarrass us to display is one we should not be recording.
 */
const REASON_LABEL: Readonly<Record<string, string>> = Object.freeze({
  account_created: 'Joined Loverlink',
  room_session_completed: 'Spent time in a room',
  promoted_to_speaker: 'Invited to speak',
  surprise_sent: 'Sent a surprise',
  surprise_redeemed: 'A surprise was opened',
  report_upheld: 'A report about you was upheld',
  report_dismissed: 'A report about you was reviewed',
  kicked_from_room: 'Removed from a room',
  banned: 'Account suspended',
  manual_adjustment: 'Adjusted by our team',
});

export default function ProfilePage() {
  const router = useRouter();
  const { status, profile, refresh, signOut } = useAuth();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  if (status === 'loading' || profile === null) {
    return (
      <main className="page page--centered">
        <div className="spinner" aria-label="Loading your profile" />
      </main>
    );
  }

  const avatar = avatarFor(profile.avatarSeed, profile.displayName);

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateMyProfile({ displayName: draftName });
      await refresh();
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that name.');
    } finally {
      setBusy(false);
    }
  };

  const newAvatar = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateMyProfile({ regenerateAvatar: true });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change your avatar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <div className="stack">
        <div className="profile-head">
          <div
            className="avatar"
            style={{
              width: '4.5rem',
              height: '4.5rem',
              background: avatar.background,
              color: avatar.foreground,
              fontSize: '1.5rem',
            }}
            aria-hidden="true"
          >
            {avatar.initials}
          </div>
          <div>
            <h1 className="profile-head__name">{profile.displayName}</h1>
            <span className="tier-badge">{TIER_LABEL[profile.tier] ?? profile.tier}</span>
          </div>
        </div>

        {error !== null && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}

        <section className="card">
          <h2 className="card__title">Your account</h2>

          <div className="detail-row">
            <span className="detail-row__label">
              {profile.identifierKind === 'phone' ? 'Phone' : 'Email'}
            </span>
            {/* Masked even to its owner: a screenshot in a support thread
                should not carry a full phone number. */}
            <span>{profile.identifierMasked}</span>
          </div>

          <div className="detail-row">
            <span className="detail-row__label">Member since</span>
            <span>
              {new Date(profile.memberSince).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </div>

          <div className="detail-row">
            <span className="detail-row__label">Standing</span>
            <span>{profile.trustScore}</span>
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">Edit</h2>

          {editing ? (
            <form onSubmit={saveName}>
              <label className="field">
                <span className="field__label">Display name</span>
                <input
                  className="input"
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  maxLength={24}
                  required
                  disabled={busy}
                  autoFocus
                />
              </label>
              <button
                className="button button--primary"
                type="submit"
                disabled={busy || draftName.trim().length < 2}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  setDraftName(profile.displayName);
                  setEditing(true);
                }}
              >
                Change display name
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={newAvatar}
                disabled={busy}
              >
                {busy ? 'Working…' : 'Give me a new avatar'}
              </button>
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">Your standing, explained</h2>

          {profile.trustHistory.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing here yet.
            </p>
          ) : (
            <ul className="ledger">
              {profile.trustHistory.map((entry, index) => (
                <li className="ledger__item" key={`${entry.at}-${index}`}>
                  <span>
                    {REASON_LABEL[entry.reason] ?? entry.reason}
                    <br />
                    <span className="faint">
                      {new Date(entry.at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </span>
                  <span
                    className={[
                      'ledger__delta',
                      entry.delta > 0 ? 'ledger__delta--positive' : '',
                      entry.delta < 0 ? 'ledger__delta--negative' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/*
          The streak, and what to do about it.

          Shown from the SERVER's computed view, never the stored counter —
          `current` goes stale the moment a day passes without a show-up, and
          rendering it raw would tell someone they have a twelve-day streak a
          week after it ended.
        */}
        <section className="card">
          <h2 className="card__title">Showing up</h2>
          {profile.streak.current === 0 ? (
            <p className="faint">
              {profile.streak.longest > 0
                ? `Your longest run was ${profile.streak.longest} days. Drop into a room to start another.`
                : 'Join a room and your streak starts today.'}
            </p>
          ) : (
            <>
              <p className="streak-count">
                <strong>{profile.streak.current}</strong>{' '}
                {profile.streak.current === 1 ? 'day' : 'days'} in a row
              </p>
              <p className="faint">
                {profile.streak.showedUpToday
                  ? 'Today already counts.'
                  : profile.streak.atRisk
                    ? 'You missed yesterday — your one skip is holding this up. Drop in today to keep it.'
                    : 'Drop into a room today to keep it going.'}
                {profile.streak.longest > profile.streak.current &&
                  ` Longest: ${profile.streak.longest}.`}
              </p>
            </>
          )}
        </section>

        <AppSettings />

        <section className="card">
          <h2 className="card__title">Session</h2>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void signOut(false)}
          >
            Sign out
          </button>
          <button className="button button--ghost" type="button" onClick={() => void signOut(true)}>
            Sign out everywhere
          </button>
        </section>

      </div>
    </main>
  );
}
