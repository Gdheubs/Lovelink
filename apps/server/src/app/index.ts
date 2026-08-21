import type { Ports } from '../domain/ports/index.js';
import { AuthenticateRequest } from './auth/AuthenticateRequest.js';
import { Logout } from './auth/Logout.js';
import { RefreshSession } from './auth/RefreshSession.js';
import { RequestLoginCode } from './auth/RequestLoginCode.js';
import { VerifyLoginCode } from './auth/VerifyLoginCode.js';
import { GetMyProfile } from './profile/GetMyProfile.js';
import { UpdateMyProfile } from './profile/UpdateMyProfile.js';
import { CreateRoom } from './rooms/CreateRoom.js';
import { Heartbeat } from './rooms/Heartbeat.js';
import { JoinRoom } from './rooms/JoinRoom.js';
import { LeaveRoom } from './rooms/LeaveRoom.js';
import { ListRooms } from './rooms/ListRooms.js';
import { SendChatMessage, SendTypingIndicator } from './chat/SendChatMessage.js';
import { SendReaction } from './chat/SendReaction.js';
import { RaiseHand } from './speaking/RaiseHand.js';
import { ApproveSpeaker } from './speaking/ApproveSpeaker.js';
import { RemoveSpeaker, StepDownAsSpeaker } from './speaking/RemoveSpeaker.js';
import { MuteSpeaker } from './speaking/MuteSpeaker.js';

export * from './auth/AuthenticateRequest.js';
export * from './auth/Logout.js';
export * from './auth/RefreshSession.js';
export * from './auth/RequestLoginCode.js';
export * from './auth/VerifyLoginCode.js';
export * from './profile/GetMyProfile.js';
export * from './profile/UpdateMyProfile.js';
export * from './rooms/CreateRoom.js';
export * from './rooms/Heartbeat.js';
export * from './rooms/JoinRoom.js';
export * from './rooms/LeaveRoom.js';
export * from './rooms/ListRooms.js';
export * from './rooms/roomStateView.js';
export * from './chat/SendChatMessage.js';
export * from './chat/SendReaction.js';
export * from './speaking/RaiseHand.js';
export * from './speaking/ApproveSpeaker.js';
export * from './speaking/RemoveSpeaker.js';
export * from './speaking/MuteSpeaker.js';

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

  // -- rooms and presence --------------------------------------------------
  readonly createRoom: CreateRoom;
  readonly listRooms: ListRooms;
  readonly joinRoom: JoinRoom;
  readonly leaveRoom: LeaveRoom;
  readonly heartbeat: Heartbeat;

  // -- chat ----------------------------------------------------------------
  readonly sendChatMessage: SendChatMessage;
  readonly sendTypingIndicator: SendTypingIndicator;
  readonly sendReaction: SendReaction;

  // -- speaking (voice) ----------------------------------------------------
  readonly raiseHand: RaiseHand;
  readonly approveSpeaker: ApproveSpeaker;
  readonly removeSpeaker: RemoveSpeaker;
  readonly stepDownAsSpeaker: StepDownAsSpeaker;
  readonly muteSpeaker: MuteSpeaker;

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

    createRoom: new CreateRoom(ports),
    listRooms: new ListRooms(ports),
    joinRoom: new JoinRoom(ports),
    leaveRoom: new LeaveRoom(ports),
    heartbeat: new Heartbeat(ports),

    sendChatMessage: new SendChatMessage(ports),
    sendTypingIndicator: new SendTypingIndicator(ports),
    sendReaction: new SendReaction(ports),

    raiseHand: new RaiseHand(ports),
    approveSpeaker: new ApproveSpeaker(ports),
    removeSpeaker: new RemoveSpeaker(ports),
    stepDownAsSpeaker: new StepDownAsSpeaker(ports),
    muteSpeaker: new MuteSpeaker(ports),
  };
}
