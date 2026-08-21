'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/AuthProvider';

/**
 * The entry point: send people where they belong.
 *
 * WHY THE `loading` BRANCH RENDERS SOMETHING NEUTRAL
 * --------------------------------------------------
 * On first paint the app genuinely does not know whether there is a session —
 * it has to try the refresh cookie. Treating "not yet known" as "signed out"
 * would flash the sign-in screen at every returning user on every reload. The
 * three-state model in AuthProvider exists precisely to make this branch
 * possible.
 */
export default function HomePage() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/rooms');
    } else if (status === 'anonymous') {
      router.replace('/signin');
    }
  }, [status, router]);

  return (
    <main className="page page--centered">
      <div className="stack center">
        <div className="brand">
          <div className="brand__mark">LOVERLINK</div>
          <div className="brand__tagline">a place to be heard</div>
        </div>
        <div className="spinner" aria-label="Loading" />
      </div>
    </main>
  );
}
