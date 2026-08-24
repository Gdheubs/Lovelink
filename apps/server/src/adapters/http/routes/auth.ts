import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import type { TokenPair } from '../../../domain/ports/TokenService.js';
import { requireAuth, actorOf } from '../authGuard.js';
import { clientIp } from '../clientIp.js';

/**
 * Authentication routes.
 *
 * EVERY HANDLER IS THREE LINES OF WORK: parse, call one use case, serialize.
 * There is no business logic here — no rate limiting, no enumeration defence,
 * no age check. All of that lives in the use cases, where the socket edge and
 * the smoke test get it too. If a handler in this file grows an `if` about
 * permissions or state, it is in the wrong ring.
 *
 * THE REFRESH TOKEN COOKIE
 * ------------------------
 * The access token is returned in the body for the client to hold in memory.
 * The refresh token is set as an httpOnly cookie:
 *
 *   httpOnly  — JavaScript cannot read it, so an XSS bug cannot exfiltrate the
 *               long-lived credential (it could still ride along on requests,
 *               but it cannot steal the token itself).
 *   sameSite  — 'lax' so the cookie survives a normal top-level navigation but
 *               is not sent on cross-site POSTs (CSRF).
 *   secure    — in production only, so local http development still works.
 *   path      — scoped to /auth, so the cookie is not attached to every API
 *               call that has no use for it.
 *
 * It is ALSO returned in the body, because a future native client has no cookie
 * jar. That is a deliberate trade: the web client should ignore the body value
 * and rely on the cookie.
 */

const REFRESH_COOKIE = 'loverlink_refresh';
const REFRESH_COOKIE_PATH = '/auth';

const requestCodeBody = z.object({
  identifier: z.string().min(3).max(254),
});

const verifyBody = z.object({
  identifier: z.string().min(3).max(254),
  code: z.string().min(4).max(12),
  // Present only when registering. The use case decides whether they are
  // required — the edge just carries them.
  displayName: z.string().min(1).max(64).optional(),
  dob: z.string().min(8).max(10).optional(),
});

const refreshBody = z
  .object({
    refreshToken: z.string().min(8).optional(),
  })
  .optional();

const logoutBody = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .optional();

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { config, useCases } = deps;

  const setRefreshCookie = (reply: FastifyReply, tokens: TokenPair): void => {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshExpiresAt,
    });
  };

  const serializeTokens = (tokens: TokenPair) => ({
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
  });

  /**
   * POST /auth/request-code
   *
   * Always answers the same way whether or not the account exists — see
   * RequestLoginCode for why that matters.
   */
  app.post('/auth/request-code', async (request, reply) => {
    const body = requestCodeBody.parse(request.body);

    const result = await useCases.requestLoginCode.execute({
      identifier: body.identifier,
      ip: clientIp(request, deps.config.TRUST_PROXY),
    });

    return reply.status(202).send({
      sent: result.sent,
      identifierKind: result.identifierKind,
      // Null in production; config refuses AUTH_ECHO_CODE there outright.
      devCode: result.devCode,
    });
  });

  /**
   * POST /auth/verify
   *
   * Logs in or registers, depending on whether the identifier is known.
   *
   * A 400 with code `REGISTRATION_REQUIRED` means "we need a name and a date of
   * birth" — the client collects them and resubmits. It is a CODE and not a
   * detail because `details` never leaves the server, and a client that has to
   * branch on something can only branch on what it receives.
   */
  app.post('/auth/verify', async (request, reply) => {
    const body = verifyBody.parse(request.body);

    const result = await useCases.verifyLoginCode.execute({
      identifier: body.identifier,
      code: body.code,
      ip: clientIp(request, deps.config.TRUST_PROXY),
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.dob === undefined ? {} : { dob: body.dob }),
    });

    setRefreshCookie(reply, result.tokens);

    return reply.status(result.isNewAccount ? 201 : 200).send({
      ...serializeTokens(result.tokens),
      profile: result.profile,
      isNewAccount: result.isNewAccount,
    });
  });

  /**
   * POST /auth/refresh
   *
   * Takes the token from the cookie, falling back to the body for clients
   * without a cookie jar.
   */
  app.post('/auth/refresh', async (request, reply) => {
    const body = refreshBody.parse(request.body);
    const cookieToken = request.cookies[REFRESH_COOKIE];
    const refreshToken = cookieToken ?? body?.refreshToken ?? '';

    const tokens = await useCases.refreshSession.execute({ refreshToken });

    setRefreshCookie(reply, tokens);
    return reply.send(serializeTokens(tokens));
  });

  /**
   * POST /auth/logout
   *
   * Requires auth: signing out is an authenticated action, and accepting an
   * unauthenticated logout would let anyone end a stranger's session by
   * guessing.
   */
  app.post('/auth/logout', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = logoutBody.parse(request.body);
    const actor = actorOf(request);

    await useCases.logout.execute({
      userId: actor.user.id,
      sessionId: actor.sessionId,
      ...(body?.allDevices === undefined ? {} : { allDevices: body.allDevices }),
    });

    // Clear the cookie as well as revoking the token, so the browser does not
    // keep presenting a credential that will only ever be refused.
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return reply.status(204).send();
  });
}


