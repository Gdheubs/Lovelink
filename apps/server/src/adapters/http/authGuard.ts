import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedActor } from '../../app/index.js';
import type { UseCases } from '../../app/index.js';

/**
 * Attaching the authenticated actor to a Fastify request.
 *
 * WHY A HELPER AND NOT A GLOBAL HOOK
 * ----------------------------------
 * A global `preHandler` that authenticates everything forces every public route
 * (health, auth, the grievance page) to opt out — and an opt-out list is a list
 * someone eventually forgets to add to, in the safe direction for them and the
 * unsafe direction for us.
 *
 * Opting IN per route means an unprotected route is visible as the ABSENCE of
 * `preHandler: requireAuth(deps)` on the line above it, which a reviewer reads
 * naturally. Forgetting it fails closed in review rather than silently in
 * production.
 */
declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

export function requireAuth(useCases: UseCases) {
  return async function preHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    // Throws UNAUTHENTICATED or BANNED, which the shared error handler maps to
    // 401/403 — so this helper contains no status codes of its own.
    request.actor = await useCases.authenticate.execute(request.headers.authorization);
  };
}

/**
 * Read the actor a `requireAuth` preHandler attached.
 *
 * Throws rather than returning null: reaching this without an actor means the
 * route forgot its preHandler, which is a programming error that must fail
 * loudly in development rather than degrade to an anonymous request.
 */
export function actorOf(request: FastifyRequest): AuthenticatedActor {
  if (request.actor === undefined) {
    throw new Error(
      `Route ${request.method} ${request.url} read the actor without requireAuth. Add preHandler: requireAuth(useCases).`,
    );
  }
  return request.actor;
}
