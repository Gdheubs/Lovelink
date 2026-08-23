/**
 * THE ONLY MODULE IN THE FRONTEND THAT CALLS `fetch`.
 *
 * WHY THAT RULE EXISTS
 * --------------------
 * Scattering fetch calls through components means every one of them
 * re-implements: the base URL, error shape parsing, the Authorization header,
 * and — the expensive one — token refresh. The fourth is what makes this
 * non-negotiable: when an access token expires mid-session, exactly one place
 * should notice, refresh, and retry. Twenty places noticing produces twenty
 * concurrent refresh calls, and because refresh tokens ROTATE, nineteen of them
 * fail and log the user out.
 *
 * So: components call typed functions from here. Nothing else touches the
 * network. The socket equivalent is `realtimeClient.ts`; the LiveKit browser
 * SDK is confined to `mediaClient.ts`. Three files, three boundaries — the same
 * shape as the server's adapters, for the same reason.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

/**
 * The access token lives in MEMORY, not localStorage.
 *
 * localStorage is readable by any script on the page, so a single XSS bug — or
 * one compromised dependency — hands over a valid session. Memory is cleared on
 * reload, which is why the REFRESH token is an httpOnly cookie the server set:
 * JavaScript cannot read it, and it is what restores the session on load.
 *
 * The cost is one refresh round-trip when a tab opens. That is the right trade.
 */
let accessToken: string | null = null;

/** Notified when auth state changes, so the AuthProvider can re-render. */
type AuthListener = (token: string | null) => void;
const listeners = new Set<AuthListener>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server's error envelope, preserved so the UI can branch on `code`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The account needs a name and date of birth before it can be created. */
  get needsRegistration(): boolean {
    return this.code === 'VALIDATION_FAILED' && this.details?.registrationRequired === true;
  }

  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
}

// ---------------------------------------------------------------------------
// The request pipeline
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the refresh-and-retry dance. Used by refresh itself, to avoid a loop. */
  skipRefresh?: boolean;
}

/**
 * A single in-flight refresh, shared by every caller that needs one.
 *
 * This is the whole reason token handling is centralised. Without it, five
 * requests failing at once trigger five refreshes; rotation means only the
 * first succeeds and the other four invalidate the session they were trying to
 * save. Sharing one promise turns a stampede into one call.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sends the httpOnly refresh cookie. Requires the server's CORS to
        // allow credentials against an explicit origin.
        credentials: 'include',
        body: '{}',
      });

      if (!response.ok) {
        setAccessToken(null);
        return false;
      }

      const data = (await response.json()) as { accessToken: string };
      setAccessToken(data.accessToken);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      // Cleared in `finally` so a failed refresh does not wedge every future
      // attempt behind a permanently-rejected promise.
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh = false } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessToken !== null) headers.authorization = `Bearer ${accessToken}`;

    return fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };

  let response = await send();

  // ONE retry, and only for an expired session. Retrying other failures would
  // duplicate side effects; retrying more than once risks a loop.
  if (response.status === 401 && !skipRefresh) {
    if (await refreshAccessToken()) {
      response = await send();
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const envelope = payload as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    throw new ApiError(
      envelope.error?.code ?? 'INTERNAL',
      envelope.error?.message ?? 'Something went wrong. Please try again.',
      response.status,
      envelope.error?.details,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export interface PublicProfile {
  id: string;
  displayName: string;
  avatarSeed: string;
  tier: 'restricted' | 'newcomer' | 'regular' | 'trusted';
}

export interface MyProfile {
  id: string;
  displayName: string;
  avatarSeed: string;
  identifierMasked: string;
  identifierKind: 'phone' | 'email';
  status: string;
  trustScore: number;
  tier: PublicProfile['tier'];
  memberSince: string;
  /** IANA zone the streak's day boundaries are computed in. */
  timeZone: string;
  /**
   * The streak as the SERVER computed it against now — never a raw stored
   * counter, which goes stale the moment a day passes without a show-up.
   */
  streak: StreakView;
  trustHistory: { delta: number; reason: string; at: string }[];
}

export interface StreakView {
  current: number;
  longest: number;
  /** True once today has been counted — the "you're safe" state. */
  showedUpToday: boolean;
  /** True when only the one free skip is holding the streak up. */
  atRisk: boolean;
  freezeAvailable: boolean;
}

export interface RoomSummary {
  id: string;
  slug: string;
  title: string;
  category: string;
  hostUserId: string;
  status: string;
  memberCount?: number;
  maxSpeakers: number;
  createdAt: string;
}

interface AuthResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  profile: PublicProfile;
  isNewAccount: boolean;
}

export type SurpriseTheme = 'love' | 'sorry' | 'miss' | 'thinking_of_you' | 'congrats';
export type SurpriseMood = 'angry' | 'sad' | 'meh' | 'happy' | 'soft' | 'tired';

export interface SurpriseTask {
  text: string;
  done: boolean;
}

export interface RevealedSurprise {
  id: string;
  displayCode: string;
  theme: SurpriseTheme;
  mood: SurpriseMood;
  /** The prepared message for this theme and mood. */
  reveal: string;
  /** What the sender wrote themselves. */
  personalMessage: string;
  tasks: SurpriseTask[];
  from: PublicProfile;
  openedAt: string;
}

export interface SentSurprise {
  id: string;
  code: string;
  theme: SurpriseTheme;
  message: string;
  opened: boolean;
  openedAt: string | null;
  expiresAt: string;
}

/**
 * Note what is NOT here: the claim code.
 *
 * It has already done its job, and repeating a live code in the recipient's own
 * history is a way for it to be read off a shared screen. The server does not
 * send it, and this type says so.
 */
export interface ReceivedSurprise {
  id: string;
  theme: SurpriseTheme;
  message: string;
  mood: SurpriseMood | null;
  tasks: SurpriseTask[];
  openedAt: string | null;
}

export type RelationshipState = 'none' | 'dm_requested' | 'dm_open' | 'call_open' | 'blocked';

/**
 * What the server says this viewer may do with this person.
 *
 * USE IT TO DECIDE WHICH BUTTONS EXIST, AND NOTHING ELSE. It is not
 * authorization — every action re-checks the same rule server-side, because a
 * client can send whatever it likes regardless of what was rendered.
 */
export interface LadderView {
  canRequestDm: boolean;
  canSendDm: boolean;
  canCall: boolean;
}

export interface Connection {
  user: PublicProfile;
  state: RelationshipState;
  since: string;
  can: LadderView;
}

export interface ConnectionsView {
  connections: Connection[];
  /** People waiting on an answer FROM you. Outgoing requests are never listed. */
  incomingRequests: Connection[];
}

export interface DmMessage {
  id: string;
  roomId: string | null;
  from: PublicProfile;
  text: string;
  sentAt: string;
}

export const api = {
  /**
   * Ask for a login code.
   *
   * `devCode` is populated only when the server has AUTH_ECHO_CODE on, which is
   * refused in production. The sign-in screen shows it so local development
   * needs no SMS provider.
   */
  async requestLoginCode(identifier: string): Promise<{
    identifierKind: 'phone' | 'email';
    devCode: string | null;
  }> {
    return request('/auth/request-code', { method: 'POST', body: { identifier } });
  },

  /**
   * Verify the code. Logs in if the account exists, registers if it does not —
   * which is why `displayName` and `dob` are optional here, exactly as the
   * server's single endpoint expects.
   *
   * Throws an ApiError with `needsRegistration` when the identifier is new and
   * those fields were not supplied.
   */
  async verifyLoginCode(input: {
    identifier: string;
    code: string;
    displayName?: string;
    dob?: string;
  }): Promise<AuthResponse> {
    const result = await request<AuthResponse>('/auth/verify', {
      method: 'POST',
      body: input,
      // A 401 here means the code was wrong, not that the session expired.
      // Refreshing would be nonsense.
      skipRefresh: true,
    });
    setAccessToken(result.accessToken);
    return result;
  },

  /**
   * Restore a session on page load using the httpOnly refresh cookie.
   * Returns false when there is no live session — the normal case for a first
   * visit, so it must not be treated as an error.
   */
  async restoreSession(): Promise<boolean> {
    return refreshAccessToken();
  },

  async logout(allDevices = false): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST', body: { allDevices } });
    } finally {
      // Cleared even if the call failed: the user asked to sign out, and
      // leaving them apparently-signed-in because the network blipped is worse
      // than a token that expires on its own.
      setAccessToken(null);
    }
  },

  async getMyProfile(): Promise<MyProfile> {
    return request('/me');
  },

  async updateMyProfile(changes: {
    displayName?: string;
    regenerateAvatar?: boolean;
  }): Promise<PublicProfile> {
    return request('/me', { method: 'PATCH', body: changes });
  },

  // -- rooms ---------------------------------------------------------------

  async listRooms(category?: string): Promise<{ rooms: RoomSummary[] }> {
    const query = category === undefined ? '' : `?category=${encodeURIComponent(category)}`;
    return request(`/rooms${query}`);
  },

  async createRoom(input: {
    title: string;
    category: string;
    maxSpeakers?: number;
  }): Promise<RoomSummary> {
    return request('/rooms', { method: 'POST', body: input });
  },

  async getRoom(id: string): Promise<RoomSummary> {
    return request(`/rooms/${encodeURIComponent(id)}`);
  },

  // -- surprises -----------------------------------------------------------

  async createSurprise(input: {
    theme: SurpriseTheme;
    message: string;
    tasks?: string[];
  }): Promise<{ id: string; code: string; theme: SurpriseTheme; expiresAt: string }> {
    return request('/surprises', { method: 'POST', body: input });
  },

  /**
   * Open one.
   *
   * `mood` is required, because it is what selects the message — the sender
   * chose what to say days ago and cannot know how the reader feels now.
   *
   * A wrong code, an expired code and one somebody else already opened are all
   * the same 404 from the server, deliberately. Do not try to tell them apart
   * in the UI: the distinction is exactly what would make guessing worthwhile.
   */
  async redeemSurprise(input: { code: string; mood: SurpriseMood }): Promise<RevealedSurprise> {
    return request('/surprises/redeem', { method: 'POST', body: input });
  },

  async toggleSurpriseTask(
    surpriseId: string,
    taskIndex: number,
    done: boolean,
  ): Promise<{ id: string; tasks: SurpriseTask[] }> {
    return request(`/surprises/${encodeURIComponent(surpriseId)}/tasks`, {
      method: 'PATCH',
      body: { taskIndex, done },
    });
  },

  async listMySurprises(): Promise<{ sent: SentSurprise[]; received: ReceivedSurprise[] }> {
    return request('/me/surprises');
  },

  // -- connections ---------------------------------------------------------

  async listConnections(): Promise<ConnectionsView> {
    return request('/me/connections');
  },

  /**
   * Ask to message someone.
   *
   * Resolves as soon as the request is accepted for delivery. It does NOT tell
   * you whether they have seen it or answered — outgoing requests are invisible
   * by design, because knowing they have not replied is an invitation to ask
   * again.
   */
  async requestDm(userId: string): Promise<void> {
    await request(`/users/${encodeURIComponent(userId)}/dm-request`, { method: 'POST' });
  },

  async acceptDm(userId: string): Promise<void> {
    await request(`/users/${encodeURIComponent(userId)}/dm-accept`, { method: 'POST' });
  },

  async declineDm(userId: string): Promise<void> {
    await request(`/users/${encodeURIComponent(userId)}/dm-decline`, { method: 'POST' });
  },

  async readDmThread(
    userId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<{ messages: DmMessage[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.before !== undefined) params.set('before', options.before);
    const query = params.toString();

    return request(
      `/users/${encodeURIComponent(userId)}/messages${query.length > 0 ? `?${query}` : ''}`,
    );
  },

  async sendDm(userId: string, text: string): Promise<DmMessage> {
    return request(`/users/${encodeURIComponent(userId)}/messages`, {
      method: 'POST',
      body: { text },
    });
  },

  /**
   * Hang up, or decline a ringing call.
   *
   * Offered over HTTP as well as the socket precisely because it must work when
   * the socket is what has gone wrong. Always succeeds, including when there
   * was no call — hanging up twice is normal.
   */
  async endCall(userId: string): Promise<void> {
    await request(`/users/${encodeURIComponent(userId)}/call-end`, { method: 'POST' });
  },

  /**
   * Tell the server which day boundary this person's streak uses.
   *
   * Stored on the account rather than read per-request, so a socket join, a
   * REST call and a background job all agree about which day it is for them.
   */
  async setTimeZone(timeZone: string): Promise<void> {
    await request('/me/timezone', { method: 'PUT', body: { timeZone } });
  },

  // -- push ----------------------------------------------------------------

  /**
   * The server's public VAPID key, or null when push is not configured.
   *
   * Null is a normal answer, not an error: a deployment without keys simply
   * does not offer notifications, and the UI must not promise something the
   * server cannot deliver.
   */
  async getPushKey(): Promise<{ publicKey: string | null }> {
    return request('/push/key');
  },

  async registerPushSubscription(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<void> {
    await request('/push/subscriptions', { method: 'PUT', body: subscription });
  },

  async removePushSubscription(endpoint: string): Promise<void> {
    await request('/push/subscriptions', { method: 'DELETE', body: { endpoint } });
  },

  async health(): Promise<{ status: string; persistence: string }> {
    return request('/healthz');
  },
};

export { API_BASE_URL };
