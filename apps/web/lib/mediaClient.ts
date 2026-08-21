/**
 * THE ONLY MODULE IN THE FRONTEND THAT WILL TOUCH THE LIVEKIT BROWSER SDK.
 *
 * WHY IT EXISTS NOW, BEFORE PHASE 3
 * ---------------------------------
 * The interface is defined and the boundary is documented before any LiveKit
 * code is written, because that ordering is what keeps the boundary real. If
 * Phase 3 started by importing `livekit-client` into a room component, the
 * abstraction would be retrofitted afterwards — around whatever shape the SDK
 * happened to impose — and it would leak.
 *
 * This mirrors the server's `MediaRoomProvider` port. Same reasoning, same
 * critical invariant:
 *
 *   THE CLIENT NEVER DECIDES WHETHER IT MAY PUBLISH.
 *
 * `connect` takes a token minted by the server. A listener's token simply does
 * not carry publish rights, so a modified client cannot grant itself a
 * microphone by flipping a boolean — it would need the server to hand it a
 * different token, which only `ApproveSpeaker` does.
 *
 * When a listener is promoted, the server sends `speaker:promoted` carrying a
 * FRESH token, and the client reconnects with it. That round trip is the
 * feature, not overhead.
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
  /** Join the audio room with a server-issued token. */
  connect(credentials: MediaCredentials): Promise<void>;

  /**
   * Replace the current credentials with a fresh token — how a promotion from
   * listener to speaker takes effect.
   */
  upgrade(credentials: MediaCredentials): Promise<void>;

  disconnect(): Promise<void>;

  /**
   * Turn the local microphone on or off.
   *
   * This is the user's OWN mute button and is purely local. A host mute is
   * enforced server-side by revoking the publish grant, precisely because a
   * client-side mute is a request that an abusive participant can decline.
   */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;

  isMicrophoneEnabled(): boolean;

  /** Who is audible, and who is currently speaking — for the speaker tiles. */
  onParticipantsChanged(
    listener: (participants: readonly MediaParticipantView[]) => void,
  ): () => void;

  onConnectionState(listener: (state: MediaConnectionState) => void): () => void;

  getState(): MediaConnectionState;
}

/**
 * Placeholder until Phase 3.
 *
 * It throws rather than no-oping. A silent stub would let a room screen appear
 * to work while nobody could hear anything, and that failure is far harder to
 * diagnose than an explicit error naming the phase that implements it.
 */
class NotYetImplementedMediaClient implements MediaClient {
  private readonly reason =
    'Voice is implemented in Phase 3. See docs/architecture.md §6 and adapters/livekit.';

  async connect(): Promise<void> {
    throw new Error(this.reason);
  }

  async upgrade(): Promise<void> {
    throw new Error(this.reason);
  }

  async disconnect(): Promise<void> {
    // Safe to no-op: tearing down a connection that was never made is fine, and
    // a component's cleanup path should not throw on unmount.
  }

  async setMicrophoneEnabled(): Promise<void> {
    throw new Error(this.reason);
  }

  isMicrophoneEnabled(): boolean {
    return false;
  }

  onParticipantsChanged(): () => void {
    return () => undefined;
  }

  onConnectionState(listener: (state: MediaConnectionState) => void): () => void {
    listener('disconnected');
    return () => undefined;
  }

  getState(): MediaConnectionState {
    return 'disconnected';
  }
}

export const media: MediaClient = new NotYetImplementedMediaClient();
