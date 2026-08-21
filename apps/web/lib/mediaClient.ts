'use client';

import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';

/**
 * THE ONLY MODULE IN THE FRONTEND THAT TOUCHES THE LIVEKIT BROWSER SDK.
 *
 * Same rule as `apiClient.ts` and `realtimeClient.ts`, and the interface below
 * was written BEFORE any LiveKit code existed — so the abstraction describes
 * what the app needs rather than what the SDK happens to expose.
 *
 * THE CRITICAL INVARIANT
 * ----------------------
 * THE CLIENT NEVER DECIDES WHETHER IT MAY PUBLISH.
 *
 * `connect` takes a token the server minted. A listener's token simply does not
 * carry publish rights, so a modified client cannot grant itself a microphone
 * by flipping a boolean — it would need the server to hand it a different
 * token, and only `ApproveSpeaker` does that.
 *
 * When someone is promoted, the server sends `speaker:promoted` carrying a
 * FRESH token and the client calls `upgrade()`, which reconnects with it. That
 * round trip is the feature, not overhead.
 *
 * MICROPHONE PERMISSION IS REQUESTED ONLY ON PROMOTION. Asking every listener
 * for their microphone the moment they walk into a room is both a terrible
 * first impression and a permission most of them will deny — after which they
 * cannot speak even once approved.
 */

export interface MediaCredentials {
  readonly token: string;
  readonly url: string;
  readonly roomName: string;
  readonly expiresAt: string;
}

export interface MediaParticipantView {
  readonly identity: string;
  readonly isSpeaking: boolean;
  readonly isMuted: boolean;
  readonly canPublish: boolean;
}

export type MediaConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface MediaClient {
  connect(credentials: MediaCredentials): Promise<void>;
  /** Replace the credentials with a fresh token — how a promotion takes effect. */
  upgrade(credentials: MediaCredentials): Promise<void>;
  disconnect(): Promise<void>;
  /** The user's OWN mute button. A host mute is enforced server-side. */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  isMicrophoneEnabled(): boolean;
  onParticipantsChanged(
    listener: (participants: readonly MediaParticipantView[]) => void,
  ): () => void;
  onConnectionState(listener: (state: MediaConnectionState) => void): () => void;
  getState(): MediaConnectionState;
  /** True when the current token permits publishing. Drives UI affordances only. */
  canPublish(): boolean;
}

class LiveKitMediaClient implements MediaClient {
  private room: Room | null = null;
  private state: MediaConnectionState = 'disconnected';
  private publishAllowed = false;

  private readonly stateListeners = new Set<(state: MediaConnectionState) => void>();
  private readonly participantListeners = new Set<
    (participants: readonly MediaParticipantView[]) => void
  >();

  /**
   * Audio elements for remote participants.
   *
   * Kept OUT of React's tree deliberately. An `<audio>` element that React
   * re-renders can be unmounted and remounted mid-sentence, which cuts the
   * audio; attaching to detached elements the SDK owns avoids tying playback
   * to render cycles.
   */
  private readonly audioElements = new Map<string, HTMLAudioElement>();

  async connect(credentials: MediaCredentials): Promise<void> {
    await this.disconnect();
    this.setState('connecting');

    const room = new Room({
      // Voice only. The product has no video, and asking the browser for a
      // camera would be both wrong and alarming.
      adaptiveStream: false,
      dynacast: true,
      audioCaptureDefaults: {
        // The three that matter for a talk room on a phone held near a face.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.room = room;
    this.wireEvents(room);

    await room.connect(credentials.url, credentials.token);

    // Whether we may publish is read from the token the SERVER issued, never
    // decided here.
    this.publishAllowed = room.localParticipant.permissions?.canPublish ?? false;

    this.setState('connected');
    this.emitParticipants();
  }

  /**
   * Reconnect with a new token.
   *
   * There is no way to widen an existing LiveKit connection's permissions — a
   * token is a bearer credential and cannot be edited after issue. So promotion
   * is a reconnect, and the brief gap is the price of the guarantee that only
   * the server can grant audio.
   */
  async upgrade(credentials: MediaCredentials): Promise<void> {
    await this.connect(credentials);

    if (this.publishAllowed) {
      // Only NOW do we ask for the microphone — at the moment it is actually
      // needed, which is also the moment the user is most likely to grant it.
      await this.setMicrophoneEnabled(true);
    }
  }

  async disconnect(): Promise<void> {
    for (const element of this.audioElements.values()) {
      element.remove();
    }
    this.audioElements.clear();

    if (this.room !== null) {
      await this.room.disconnect();
      this.room = null;
    }
    this.publishAllowed = false;
    this.setState('disconnected');
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (this.room === null) return;

    if (enabled && !this.publishAllowed) {
      // Refuse locally too. The server would reject the track anyway, but
      // failing here gives a comprehensible error instead of silence.
      throw new Error('You do not have the floor yet.');
    }
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  isMicrophoneEnabled(): boolean {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  canPublish(): boolean {
    return this.publishAllowed;
  }

  onParticipantsChanged(
    listener: (participants: readonly MediaParticipantView[]) => void,
  ): () => void {
    this.participantListeners.add(listener);
    listener(this.snapshotParticipants());
    return () => this.participantListeners.delete(listener);
  }

  onConnectionState(listener: (state: MediaConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  getState(): MediaConnectionState {
    return this.state;
  }

  // -------------------------------------------------------------------------

  private wireEvents(room: Room): void {
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;

        // Attach to a detached element rather than a React-managed node, so a
        // re-render cannot interrupt someone mid-sentence.
        const element = track.attach() as HTMLAudioElement;
        element.autoplay = true;
        this.audioElements.set(track.sid ?? String(this.audioElements.size), element);
        document.body.appendChild(element);

        this.emitParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((element) => element.remove());
        if (track.sid !== undefined) this.audioElements.delete(track.sid);
        this.emitParticipants();
      })
      .on(RoomEvent.ParticipantConnected, () => this.emitParticipants())
      .on(RoomEvent.ParticipantDisconnected, () => this.emitParticipants())
      .on(RoomEvent.TrackMuted, () => this.emitParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.emitParticipants())
      // Who is talking right now — the speaking indicator the room screen shows.
      .on(RoomEvent.ActiveSpeakersChanged, () => this.emitParticipants())
      .on(RoomEvent.Reconnecting, () => this.setState('reconnecting'))
      .on(RoomEvent.Reconnected, () => {
        this.setState('connected');
        this.emitParticipants();
      })
      .on(RoomEvent.Disconnected, () => {
        this.setState('disconnected');
        this.emitParticipants();
      })
      /**
       * The server revoked our publish permission — a host removed us as a
       * speaker, or muted us. Reflect it locally so the UI stops showing a live
       * microphone.
       *
       * NOTE this is a NOTIFICATION of enforcement that already happened at the
       * media server, not the enforcement itself. The audio stopped whether or
       * not this handler runs.
       */
      .on(RoomEvent.ParticipantPermissionsChanged, () => {
        this.publishAllowed = room.localParticipant.permissions?.canPublish ?? false;
        this.emitParticipants();
      });
  }

  private snapshotParticipants(): readonly MediaParticipantView[] {
    const room = this.room;
    if (room === null) return [];

    const everyone: (RemoteParticipant | typeof room.localParticipant)[] = [
      room.localParticipant,
      ...room.remoteParticipants.values(),
    ];

    return everyone.map((participant) => {
      const audio = [...participant.trackPublications.values()].find(
        (publication) => publication.kind === Track.Kind.Audio,
      ) as RemoteTrackPublication | undefined;

      return {
        identity: participant.identity,
        isSpeaking: participant.isSpeaking,
        isMuted: audio?.isMuted ?? true,
        canPublish: participant.permissions?.canPublish ?? false,
      };
    });
  }

  private emitParticipants(): void {
    const snapshot = this.snapshotParticipants();
    for (const listener of this.participantListeners) listener(snapshot);
  }

  private setState(next: MediaConnectionState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}

export const media: MediaClient = new LiveKitMediaClient();
