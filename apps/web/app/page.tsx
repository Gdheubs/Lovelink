'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/AuthProvider';

/**
 * The front door.
 *
 * WHY THERE IS A WELCOME SCREEN AT ALL
 * ------------------------------------
 * This used to redirect straight to sign-in, which asked for a phone number
 * before saying what the place was. That is the wrong order: a product about
 * talking to strangers has to earn an identifier, and nobody hands one over to
 * a form.
 *
 * So an anonymous visitor gets a page that answers three questions before
 * asking anything — what this is, what happens when you arrive, and what it
 * refuses to do. Someone with a session is sent on and never sees it.
 *
 * WHY THE OPENING IS A QUOTE AND NOT A VALUE PROPOSITION
 * ------------------------------------------------------
 * "Connect with people who get you" is what every social app says, and it says
 * nothing. A sentence about being awake at 2am does more work: the people this
 * is for recognise themselves in it immediately, and the people it is not for
 * also learn something true.
 */
export default function WelcomePage() {
  const { status } = useAuth();
  const router = useRouter();

  /**
   * The reveal sequence.
   *
   * Three beats, and it is over in under two seconds. Long enough to feel like
   * arriving somewhere rather than loading something; short enough that the
   * second visit is not an obstacle. Reduced-motion users get the final state
   * immediately, because the animation is atmosphere and atmosphere is optional.
   */
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still) {
        setBeat(3);
        return;
      }
    }

    const timers = [
      setTimeout(() => setBeat(1), 260),
      setTimeout(() => setBeat(2), 1150),
      setTimeout(() => setBeat(3), 1750),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // Someone already signed in has no business reading the pitch.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/home');
  }, [status, router]);

  /*
   * The welcome renders IMMEDIATELY, before the session is known.
   *
   * The obvious thing is to wait for `status` and show a spinner meanwhile.
   * That is right for a protected screen and wrong for this one: it is the
   * first thing anybody sees, often on a slow phone, and gating it on a
   * round-trip means a blank screen for however long that takes.
   *
   * A signed-in visitor is redirected by the effect above. They see this for a
   * fraction of a second, which costs them nothing — while waiting would cost
   * every first-time visitor the whole first impression.
   */
  if (status === 'authenticated') {
    return (
      <main className="page page--centered">
        <div className="brand-quiet">Loverlink</div>
      </main>
    );
  }

  return (
    <main className="welcome">
      <section className={`welcome-hero beat-${beat}`}>
        <p className="brand-quiet reveal-1">Loverlink</p>

        <blockquote className="welcome-quote reveal-2">
          Some conversations only happen late, with people who were never going to
          judge you for having them.
        </blockquote>

        <p className="welcome-sub reveal-3">
          A room full of strangers, most of them listening. Come in and see.
        </p>
      </section>

      <section className={`welcome-body reveal-3 beat-${beat}`}>
        <p className="t-over">How it works</p>

        {/*
          Three steps, in the order they happen. The first one is the whole
          product and is deliberately stated as a permission rather than a
          feature: you are ALLOWED to say nothing.
        */}
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <div>
              <p className="t-md">You arrive silent</p>
              <p className="t-sm">
                You can hear the room and read along. Nobody can hear you, and nobody expects you
                to speak.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <div>
              <p className="t-md">You speak when you want to</p>
              <p className="t-sm">
                Raise a hand. The host lets you in. You can stop whenever you like.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">3</span>
            <div>
              <p className="t-md">Closeness is earned, in that order</p>
              <p className="t-sm">
                Share a room, then ask to message, then talk one to one. Each step needs the other
                person to agree.
              </p>
            </div>
          </li>
        </ol>

        {/*
          What it refuses to do. Stating the absences is the fastest way to say
          what kind of place this is — and every line here is enforced in code,
          not aspiration.
        */}
        <p className="t-over" style={{ marginTop: '2.25rem' }}>
          What you will not find
        </p>
        <ul className="nots">
          <li>No followers, no likes, no counts to grow</li>
          <li>Nobody can message you out of nowhere</li>
          <li>Declining anything is silent — they are never told</li>
          <li>Nothing you say appears on a notification</li>
        </ul>

        <div className="welcome-actions">
          <Link href="/signin" className="button button--primary">
            Come in
          </Link>
          <p className="t-sm center welcome-age">18+ · we check, and we never show it to anyone</p>
        </div>
      </section>
    </main>
  );
}
