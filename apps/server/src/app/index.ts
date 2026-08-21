import type { Ports } from '../domain/ports/index.js';
import { AuthenticateRequest } from './auth/AuthenticateRequest.js';
import { Logout } from './auth/Logout.js';
import { RefreshSession } from './auth/RefreshSession.js';
import { RequestLoginCode } from './auth/RequestLoginCode.js';
import { VerifyLoginCode } from './auth/VerifyLoginCode.js';
import { GetMyProfile } from './profile/GetMyProfile.js';
import { UpdateMyProfile } from './profile/UpdateMyProfile.js';

export * from './auth/AuthenticateRequest.js';
export * from './auth/Logout.js';
export * from './auth/RefreshSession.js';
export * from './auth/RequestLoginCode.js';
export * from './auth/VerifyLoginCode.js';
export * from './profile/GetMyProfile.js';
export * from './profile/UpdateMyProfile.js';

/**
 * The application ring: one file per use case.
 *
 * A use case is a class whose constructor takes ports and which exposes a
 * single `execute` method. That uniformity is not ceremony — it is what lets
 * the HTTP edge, the socket edge, the smoke test and any future admin tool
 * invoke the same logic the same way, and it is what makes "authorization is
 * checked server-side" verifiable by reading one file rather than three
 * transports.
 *
 * RULES FOR THIS DIRECTORY (enforced by eslint, see eslint.config.js)
 *  - No vendor imports. Take a port.
 *  - No imports from /adapters. Ports arrive via the constructor.
 *  - No `new Date()` and no `Math.random()`. Take Clock and IdGenerator.
 *  - Every use case checks authorization itself. Never assume the edge did.
 */

/**
 * Everything the edges may invoke.
 *
 * Keeping it as one named type means adding a use case is a compile error at
 * every construction site rather than a runtime `undefined` discovered by a
 * user.
 */
export interface UseCases {
  // -- auth ----------------------------------------------------------------
  readonly authenticate: AuthenticateRequest;
  readonly requestLoginCode: RequestLoginCode;
  readonly verifyLoginCode: VerifyLoginCode;
  readonly refreshSession: RefreshSession;
  readonly logout: Logout;

  // -- profile -------------------------------------------------------------
  readonly getMyProfile: GetMyProfile;
  readonly updateMyProfile: UpdateMyProfile;

  // Phase 2 adds the room and chat use cases.
  // Phase 3 adds hand-raise and speaker management.
  // Phase 4 adds reports, bans and moderation.
  // Phase 5 adds surprises, DMs and calls.
}

export interface UseCaseOptions {
  /**
   * Return login codes to the caller. Development only — config.ts refuses
   * this in production, where it would hand every account to anyone who knows
   * a phone number.
   */
  readonly echoLoginCode: boolean;
}

/**
 * Assemble every use case from the port bundle. Called once, at boot, by the
 * composition root in /src/main.ts.
 */
export function createUseCases(ports: Ports, options: UseCaseOptions): UseCases {
  return {
    authenticate: new AuthenticateRequest(ports),
    requestLoginCode: new RequestLoginCode(ports, { echoCode: options.echoLoginCode }),
    verifyLoginCode: new VerifyLoginCode(ports),
    refreshSession: new RefreshSession(ports),
    logout: new Logout(ports),

    getMyProfile: new GetMyProfile(ports),
    updateMyProfile: new UpdateMyProfile(ports),
  };
}
