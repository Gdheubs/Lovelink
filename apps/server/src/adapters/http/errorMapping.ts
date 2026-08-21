import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Logger } from '../../domain/ports/Logger.js';
import type { Metrics } from '../../domain/ports/Metrics.js';
import { httpStatusForCode, isDomainError } from '../../domain/errors.js';

/**
 * The single place where a thrown error becomes an HTTP response.
 *
 * WHY ONE PLACE
 * -------------
 * Route handlers should read as `parse -> call use case -> serialize`. The
 * moment one of them starts try/catching to decide a status code, two things
 * follow: the mapping drifts between routes, and one of them eventually leaks
 * an internal message to a client. Centralising it means a use case simply
 * throws its domain error and the correct status arrives for free.
 *
 * THE SECURITY-RELEVANT PART
 * --------------------------
 * A DomainError is something we deliberately produced and its `message` is
 * written for a user, so it is safe to return. Anything else is a BUG, and its
 * message may contain a connection string, a query, or a stack — so unexpected
 * errors are logged in full and answered with a generic message plus a
 * correlation id the user can quote to support.
 *
 * THE THREE FAMILIES, IN ORDER OF SPECIFICITY
 *   1. ZodError            — the caller sent the wrong shape.       400
 *   2. DomainError         — a rule we deliberately enforced.       varies
 *   3. Fastify 4xx         — the framework rejected the request.    as given
 *   4. everything else     — our bug.                               500
 */

export interface ErrorResponse {
  readonly error: { readonly code: string; readonly message: string; readonly requestId?: string };
}

/**
 * Turn a schema failure into something a developer integrating against the API
 * can act on: which field, and what was wrong with it.
 *
 * Field PATHS are safe to return — the client sent them. The raw zod message is
 * not always friendly, but it is far better than "something went wrong", and
 * this endpoint's audience for a 400 is a developer, not an end user.
 */
function describeSchemaFailure(error: ZodError): string {
  const [first] = error.issues;
  if (first === undefined) return 'That request was not in a form we understand.';

  const path = first.path.join('.');
  return path.length > 0
    ? `Invalid value for "${path}": ${first.message.toLowerCase()}.`
    : first.message;
}

export function buildErrorHandler(logger: Logger, metrics: Metrics) {
  return function handleError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply {
    const requestId = request.id;

    // 1. Schema validation at the edge.
    //
    // WITHOUT THIS BRANCH every malformed body became a 500 with a stack trace
    // in the logs — the caller could not tell a typo from an outage, and we
    // could not tell a probe from a real fault. A ZodError is by definition the
    // caller's mistake, so it is a 400.
    if (error instanceof ZodError) {
      metrics.increment('error.domain');
      logger.info(
        { requestId, route: request.url, issues: error.issues },
        'request rejected: invalid shape',
      );
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: describeSchemaFailure(error) },
      } satisfies ErrorResponse);
    }

    // 2. A rule we deliberately enforced.
    if (isDomainError(error)) {
      metrics.increment('error.domain');
      // `details` goes to the log, never to the client — see errors.ts.
      logger.info(
        { requestId, code: error.code, route: request.url, details: error.details },
        'request rejected',
      );
      return reply
        .status(httpStatusForCode(error.code))
        .send({ error: { code: error.code, message: error.message } } satisfies ErrorResponse);
    }

    // 3. Fastify's own rejections (body too large, malformed JSON, and so on)
    //    already carry a status.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      metrics.increment('error.domain');
      return reply.status(statusCode).send({
        error: { code: 'VALIDATION_FAILED', message: error.message },
      } satisfies ErrorResponse);
    }

    // 4. Genuine bug. Log everything, disclose nothing.
    metrics.increment('error.unexpected');
    logger.error(
      {
        requestId,
        route: request.url,
        method: request.method,
        err: error.message,
        stack: error.stack,
      },
      'unhandled error',
    );
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        requestId,
      },
    } satisfies ErrorResponse);
  };
}
