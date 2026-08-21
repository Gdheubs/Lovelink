'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/apiClient';
import { useAuth } from '../../lib/AuthProvider';

/**
 * Sign in / sign up.
 *
 * ONE SCREEN, NOT TWO — and that is a security decision, not a design one.
 *
 * A separate "sign up" and "log in" flow requires the app to know, before the
 * user proves anything, whether an account exists for that phone number or
 * email. That turns the endpoint into a "does this person use Loverlink?"
 * oracle — which for a platform built around late-night intimate conversation
 * is a real safety problem, not a privacy nicety.
 *
 * So the server answers identically either way, and the client finds out only
 * AFTER the code is verified: if the account is new, the server responds with
 * `registrationRequired` and we ask for a name and date of birth then.
 *
 * The resulting states:
 *   identify -> verify -> (register) -> done
 */
type Stage = 'identify' | 'verify' | 'register';

export default function SignInPage() {
  const router = useRouter();
  const { status, onSignedIn } = useAuth();

  const [stage, setStage] = useState<Stage>('identify');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [dob, setDob] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const codeInputRef = useRef<HTMLInputElement>(null);

  // Someone who is already signed in has no business here.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/profile');
  }, [status, router]);

  // Move focus with the flow, so a phone keyboard stays useful and a screen
  // reader announces the new step rather than leaving focus on a stale button.
  useEffect(() => {
    if (stage === 'verify') codeInputRef.current?.focus();
  }, [stage]);

  const submitIdentifier = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await api.requestLoginCode(identifier);
      setDevCode(result.devCode);
      setStage('verify');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api.verifyLoginCode({ identifier, code });
      await onSignedIn();
      router.replace('/profile');
    } catch (caught) {
      // The one branch that is not a failure: the identifier is new, so the
      // server is asking for the details it needs to create the account.
      if (caught instanceof ApiError && caught.needsRegistration) {
        setStage('register');
        setError(null);
      } else {
        setError(messageFor(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitRegistration = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await api.verifyLoginCode({ identifier, code, displayName, dob });
      await onSignedIn();
      router.replace('/profile');
    } catch (caught) {
      setError(messageFor(caught));

      // The code is single-use, so a failure AFTER it was consumed (anything
      // other than the age gate rejecting the date) means they must start over.
      // Saying so beats letting them retype a name against a dead code.
      if (caught instanceof ApiError && caught.code !== 'UNDERAGE') {
        setStage('identify');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--centered">
      <div className="stack">
        <div className="brand">
          <div className="brand__mark">LOVERLINK</div>
          <div className="brand__tagline">a place to be heard</div>
        </div>

        {error !== null && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}

        {stage === 'identify' && (
          <form className="card" onSubmit={submitIdentifier}>
            <h1 className="card__title">Sign in or join</h1>

            <label className="field">
              <span className="field__label">Phone number or email</span>
              <input
                className="input"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="+447700900000"
                autoComplete="username"
                // Not `type="email"`: this field accepts a phone number too, and
                // the browser would reject a valid one with its own validation.
                inputMode="text"
                required
                disabled={busy}
              />
              <span className="field__hint">
                For a phone number, include the country code (starting with +).
              </span>
            </label>

            <button
              className="button button--primary"
              type="submit"
              disabled={busy || identifier.trim().length < 3}
            >
              {busy ? 'Sending…' : 'Send me a code'}
            </button>

            <p className="faint center" style={{ marginTop: '1.2rem', marginBottom: 0 }}>
              Loverlink is for adults only. You must be 18 or over.
            </p>
          </form>
        )}

        {stage === 'verify' && (
          <form className="card" onSubmit={submitCode}>
            <h1 className="card__title">Enter your code</h1>

            <p className="muted" style={{ marginTop: 0 }}>
              We sent a 6-digit code to <strong>{identifier}</strong>.
            </p>

            {devCode !== null && (
              <div className="notice notice--dev">
                Development mode — your code is <strong>{devCode}</strong>
              </div>
            )}

            <label className="field">
              <span className="field__label">6-digit code</span>
              <input
                ref={codeInputRef}
                className="input input--code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                // Lets iOS and Android offer the code straight from the SMS.
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                required
                disabled={busy}
              />
            </label>

            <button
              className="button button--primary"
              type="submit"
              disabled={busy || code.length < 6}
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>

            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                setStage('identify');
                setCode('');
                setError(null);
              }}
              disabled={busy}
            >
              Use a different number
            </button>
          </form>
        )}

        {stage === 'register' && (
          <form className="card" onSubmit={submitRegistration}>
            <h1 className="card__title">Welcome — one more step</h1>

            <p className="muted" style={{ marginTop: 0 }}>
              You are new here. Tell us what to call you.
            </p>

            <label className="field">
              <span className="field__label">Display name</span>
              <input
                className="input"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="What should people call you?"
                autoComplete="nickname"
                maxLength={24}
                required
                disabled={busy}
              />
              <span className="field__hint">This is what everyone in a room will see.</span>
            </label>

            <label className="field">
              <span className="field__label">Date of birth</span>
              <input
                className="input"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                required
                disabled={busy}
              />
              <span className="field__hint">
                Loverlink is 18+. We check this on our side, and we never show it to anyone.
              </span>
            </label>

            <button
              className="button button--primary"
              type="submit"
              disabled={busy || displayName.trim().length < 2 || dob === ''}
            >
              {busy ? 'Creating your account…' : 'Create my account'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

/**
 * Turn a thrown value into something worth showing a person.
 *
 * The server writes its `message` for users (see domain/errors.ts), so it is
 * safe and usually better than anything invented here. Everything else gets a
 * generic line, because an unexpected error's message can contain internals.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) {
    // `fetch` throws a TypeError when it cannot reach the host at all.
    return 'Cannot reach Loverlink. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}
