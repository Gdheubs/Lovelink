import type { Ports } from '../domain/ports/index.js';
import { AuthenticateRequest } from './auth/AuthenticateRequest.js';
import { Logout } from './auth/Logout.js';
import { RefreshSession } from './auth/RefreshSession.js';
import { RequestLoginCode } from './auth/RequestLoginCode.js';
import { VerifyLoginCode } from './auth/VerifyLoginCode.js';
import { GetMyProfile } from './profile/GetMyProfile.js';
import { UpdateMyProfile } from './profile/UpdateMyProfile.js';
import { GetStreak, RecordShowUp, SetTimeZone } from './profile/RecordShowUp.js';
import { CreateRoom } from './rooms/CreateRoom.js';
import { Heartbeat } from './rooms/Heartbeat.js';
import { JoinRoom } from './rooms/JoinRoom.js';
import { LeaveRoom } from './rooms/LeaveRoom.js';
import { ListRooms } from './rooms/ListRooms.js';
import { OpenScheduledRooms } from './rooms/OpenScheduledRooms.js';
import { SendChatMessage, SendTypingIndicator } from './chat/SendChatMessage.js';
import { SendReaction } from './chat/SendReaction.js';
import { RaiseHand } from './speaking/RaiseHand.js';
import { ApproveSpeaker } from './speaking/ApproveSpeaker.js';
import { RemoveSpeaker, StepDownAsSpeaker } from './speaking/RemoveSpeaker.js';
import { MuteSpeaker } from './speaking/MuteSpeaker.js';
import { SubmitReport } from './safety/SubmitReport.js';
import { BanUser, LiftBan } from './safety/BanUser.js';
import { ClaimReport, ListReportQueue, ResolveReport } from './safety/ReviewReports.js';
import { BlockUser, UnblockUser } from './safety/BlockUser.js';
import { KickUser } from './safety/KickUser.js';
import { GetDashboard } from './admin/GetDashboard.js';
import { ClearIntent, GetHome, SetIntent } from './home/GetHome.js';
import {
  RegisterPushSubscription,
  RemovePushSubscription,
  SendPush,
} from './push/ManagePushSubscriptions.js';
import { CreateSurprise } from './surprises/CreateSurprise.js';
import { RedeemSurprise, ToggleSurpriseTask } from './surprises/RedeemSurprise.js';
import { ListMySurprises } from './surprises/ListMySurprises.js';
import { AcceptDm, DeclineDm, RequestDm } from './connections/RequestDm.js';
import { ReadDmThread, SendDm } from './connections/SendDm.js';
import { ListConnections } from './connections/ListConnections.js';
import { AcceptCall, EndCall, InviteToCall } from './connections/CallUser.js';
import type { ModeratorDirectory } from '../domain/rules/moderation.js';
import { asUserId } from '../domain/values/ids.js';

export * from './auth/AuthenticateRequest.js';
export * from './auth/Logout.js';
export * from './auth/RefreshSession.js';
export * from './auth/RequestLoginCode.js';
export * from './auth/VerifyLoginCode.js';
export * from './profile/GetMyProfile.js';
export * from './profile/UpdateMyProfile.js';
export * from './profile/RecordShowUp.js';
export * from './rooms/CreateRoom.js';
export * from './rooms/Heartbeat.js';
export * from './rooms/JoinRoom.js';
export * from './rooms/LeaveRoom.js';
export * from './rooms/ListRooms.js';
export * from './rooms/OpenScheduledRooms.js';
export * from './rooms/roomStateView.js';
export * from './chat/SendChatMessage.js';
export * from './chat/SendReaction.js';
export * from './speaking/RaiseHand.js';
export * from './speaking/ApproveSpeaker.js';
export * from './speaking/RemoveSpeaker.js';
export * from './speaking/MuteSpeaker.js';
export * from './safety/SubmitReport.js';
export * from './safety/BanUser.js';
export * from './safety/ReviewReports.js';
export * from './safety/BlockUser.js';
export * from './safety/KickUser.js';
export * from './admin/GetDashboard.js';
export * from './home/GetHome.js';
export * from './push/ManagePushSubscriptions.js';
export * from './surprises/CreateSurprise.js';
export * from './surprises/RedeemSurprise.js';
export * from './surprises/ListMySurprises.js';
export * from './connections/RequestDm.js';
export * from './connections/SendDm.js';
export * from './connections/ListConnections.js';
export * from './connections/CallUser.js';

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
  readonly recordShowUp: RecordShowUp;
  readonly getStreak: GetStreak;
  readonly setTimeZone: SetTimeZone;

  // -- rooms and presence --------------------------------------------------
  readonly createRoom: CreateRoom;
  readonly listRooms: ListRooms;
  readonly joinRoom: JoinRoom;
  readonly leaveRoom: LeaveRoom;
  readonly heartbeat: Heartbeat;
  readonly openScheduledRooms: OpenScheduledRooms;

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

  // -- safety and moderation -----------------------------------------------
  readonly submitReport: SubmitReport;
  readonly listReportQueue: ListReportQueue;
  readonly claimReport: ClaimReport;
  readonly resolveReport: ResolveReport;
  readonly banUser: BanUser;
  readonly liftBan: LiftBan;
  readonly blockUser: BlockUser;
  readonly unblockUser: UnblockUser;
  readonly kickUser: KickUser;
  readonly getDashboard: GetDashboard;

  // -- home -----------------------------------------------------------------
  readonly getHome: GetHome;
  readonly setIntent: SetIntent;
  readonly clearIntent: ClearIntent;

  // -- push -----------------------------------------------------------------
  readonly registerPushSubscription: RegisterPushSubscription;
  readonly removePushSubscription: RemovePushSubscription;
  readonly sendPush: SendPush;

  // -- surprises (rung 0 of the ladder: no relationship required) -----------
  readonly createSurprise: CreateSurprise;
  readonly redeemSurprise: RedeemSurprise;
  readonly toggleSurpriseTask: ToggleSurpriseTask;
  readonly listMySurprises: ListMySurprises;

  // -- connections: DM (rung 3) --------------------------------------------
  readonly requestDm: RequestDm;
  readonly acceptDm: AcceptDm;
  readonly declineDm: DeclineDm;
  readonly sendDm: SendDm;
  readonly readDmThread: ReadDmThread;
  readonly listConnections: ListConnections;

  // -- connections: 1:1 call (rung 4) --------------------------------------
  readonly inviteToCall: InviteToCall;
  readonly acceptCall: AcceptCall;
  readonly endCall: EndCall;

  // Phase 5 adds surprises, DMs and calls.
}

export interface UseCaseOptions {
  /**
   * Return login codes to the caller. Development only — config.ts refuses
   * this in production, where it would hand every account to anyone who knows
   * a phone number.
   */
  readonly echoLoginCode: boolean;

  /**
   * User ids with moderator powers, from validated config.
   *
   * A config allowlist rather than a database role: anyone who can write a
   * user row must not be able to mint a moderator. See rules/moderation.ts.
   */
  readonly moderatorUserIds: readonly string[];
}

/**
 * Assemble every use case from the port bundle. Called once, at boot, by the
 * composition root in /src/main.ts.
 */
export function createUseCases(ports: Ports, options: UseCaseOptions): UseCases {
  const moderators: ModeratorDirectory = {
    moderatorIds: new Set(options.moderatorUserIds.map(asUserId)),
  };

  // Departure has ONE implementation, and ban and kick both route through it
  // rather than reimplementing cleanup. See the audit's F-series for what
  // happens when a second path diverges.
  const leaveRoom = new LeaveRoom(ports);

  return {
    authenticate: new AuthenticateRequest(ports),
    requestLoginCode: new RequestLoginCode(ports, { echoCode: options.echoLoginCode }),
    verifyLoginCode: new VerifyLoginCode(ports),
    refreshSession: new RefreshSession(ports),
    logout: new Logout(ports),

    getMyProfile: new GetMyProfile(ports),
    updateMyProfile: new UpdateMyProfile(ports),
    recordShowUp: new RecordShowUp(ports),
    getStreak: new GetStreak(ports),
    setTimeZone: new SetTimeZone(ports),

    createRoom: new CreateRoom(ports),
    listRooms: new ListRooms(ports),
    joinRoom: new JoinRoom(ports),
    leaveRoom,
    heartbeat: new Heartbeat(ports),
    openScheduledRooms: new OpenScheduledRooms(ports),

    sendChatMessage: new SendChatMessage(ports),
    sendTypingIndicator: new SendTypingIndicator(ports),
    sendReaction: new SendReaction(ports),

    raiseHand: new RaiseHand(ports),
    approveSpeaker: new ApproveSpeaker(ports),
    removeSpeaker: new RemoveSpeaker(ports),
    stepDownAsSpeaker: new StepDownAsSpeaker(ports),
    muteSpeaker: new MuteSpeaker(ports),

    submitReport: new SubmitReport(ports),
    listReportQueue: new ListReportQueue(ports, moderators),
    claimReport: new ClaimReport(ports, moderators),
    resolveReport: new ResolveReport(ports, moderators),
    banUser: new BanUser(ports, moderators, leaveRoom),
    liftBan: new LiftBan(ports, moderators),
    blockUser: new BlockUser(ports),
    unblockUser: new UnblockUser(ports),
    kickUser: new KickUser(ports, leaveRoom),
    getDashboard: new GetDashboard(ports),

    getHome: new GetHome(ports),
    setIntent: new SetIntent(ports),
    clearIntent: new ClearIntent(ports),

    registerPushSubscription: new RegisterPushSubscription(ports),
    removePushSubscription: new RemovePushSubscription(ports),
    sendPush: new SendPush(ports),

    createSurprise: new CreateSurprise(ports),
    redeemSurprise: new RedeemSurprise(ports),
    toggleSurpriseTask: new ToggleSurpriseTask(ports),
    listMySurprises: new ListMySurprises(ports),

    requestDm: new RequestDm(ports),
    acceptDm: new AcceptDm(ports),
    declineDm: new DeclineDm(ports),
    sendDm: new SendDm(ports),
    readDmThread: new ReadDmThread(ports),
    listConnections: new ListConnections(ports),

    inviteToCall: new InviteToCall(ports),
    acceptCall: new AcceptCall(ports),
    endCall: new EndCall(ports),
  };
}
