'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/AuthProvider';
import { useRoom } from '../../../lib/useRoom';
import { api } from '../../../lib/apiClient';
import { RoomScreen } from './RoomScreen';

/**
 * The room route.
 *
 * A THIN WRAPPER on purpose: it resolves the id, waits for a session, joins,
 * and hands everything to `RoomScreen`. All the judgement about what a person
 * is shown lives there, in one file, next to the reasons.
 *
 * WHAT THIS PAGE STILL OWNS
 * -------------------------
 * The two things that are genuinely about the route rather than the room:
 * sending someone to sign in, and fetching the room's temperature — which
 * comes over HTTP because it is a property of the room rather than of the live
 * session, and does not change while somebody is inside.
 */
export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { status, profile } = useAuth();

  const roomId = typeof params.id === 'string' ? params.id : null;

  const { state, messages, error, canPublish, micEnabled, toggleMic, raiseHand, approveSpeaker, sendMessage, leave } =
    useRoom(status === 'authenticated' ? roomId : null, profile?.id ?? null);

  /**
   * The room's temperature.
   *
   * Not in the realtime snapshot because it is not live state — it is the
   * host's contract, fixed for the life of the room. Fetching it once is
   * cheaper than putting it in every broadcast.
   */
  const [temperature, setTemperature] = useState('warm');

  useEffect(() => {
    if (roomId === null || status !== 'authenticated') return;

    let cancelled = false;
    void api
      .getRoom(roomId)
      .then((room) => {
        if (!cancelled) setTemperature((room as { temperature?: string }).temperature ?? 'warm');
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [roomId, status]);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/signin');
  }, [status, router]);

  if (status !== 'authenticated' || roomId === null || state === null) {
    return (
      <main className="page page--centered">
        {/*
          "Joining quietly", not "Loading". The wait is short and the sentence
          is the first thing the product says about what is about to happen —
          which is that nobody will hear you when you arrive.
        */}
        <p className="t-sm">{error ?? 'Joining quietly…'}</p>
      </main>
    );
  }

  return (
    <RoomScreen
      state={state}
      temperature={temperature}
      messages={messages}
      myUserId={profile?.id ?? ''}
      canPublish={canPublish}
      micEnabled={micEnabled}
      onToggleMic={() => void toggleMic()}
      onSend={sendMessage}
      onRaiseHand={raiseHand}
      onApprove={approveSpeaker}
      onLeave={() => {
        // Leaves the audio room and the socket room, then goes home. No
        // confirmation and nothing announced: "leave quietly" means it.
        leave();
        router.replace('/home');
      }}
    />
  );
}
