import type { FastifyReply, FastifyRequest } from 'fastify';
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
 */

export interface ErrorResponse {
  readonly error: { readonly code: string; readonly message: string; readonly requestId?: string };
}

export function buildErrorHandler(logger: Logger, metrics: Metrics) {
  return function handleError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply {
    const requestId = request.id;

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

    // Fastify's own schema validation failures arrive with a statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      metrics.increment('error.domain');
      return reply.status(statusCode).send({
        error: { code: 'VALIDATION_FAILED', message: error.message },
      } satisfies ErrorResponse);
    }

    // Genuine bug. Log everything, disclose nothing.
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
