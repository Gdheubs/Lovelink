/**
 * Domain error taxonomy.
 *
 * WHY THIS EXISTS
 * ---------------
 * Use cases must be able to fail in a way that the HTTP adapter can turn into a
 * status code and the socket adapter can turn into an `error {code, message}`
 * event — WITHOUT either adapter knowing anything about the business rules that
 * produced the failure. So every failure carries a stable machine-readable
 * `code`, and the mapping code -> HTTP status lives here (one place) rather than
 * being re-derived at each edge.
 *
 * INVARIANT: `message` is safe to show a user. Anything sensitive (which record,
 * whose id, what the internal state was) goes in `details`, which is logged but
 * never serialized to a client.
 */

/** Stable, client-visible failure codes. Never renumber or reuse these. */
export type DomainErrorCode =
  // validation / input
  | 'VALIDATION_FAILED'
  | 'UNDERAGE'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CODE'
  // authorization
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_HOST'
  | 'BANNED'
  | 'BLOCKED'
  | 'TRUST_LADDER_VIOLATION'
  // state
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ROOM_CLOSED'
  | 'ROOM_FULL'
  | 'SPEAKER_SLOTS_FULL'
  | 'ALREADY_REDEEMED'
  // throttling / infrastructure-shaped but domain-meaningful
  | 'RATE_LIMITED'
  | 'INTERNAL';

/** Base class for every expected (non-bug) failure the domain can produce. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  /** Structured context for logs. NEVER sent to a client. */
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    // Keeps `instanceof` working when compiled down and makes stacks readable.
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, details);
  }
}

export class AuthorizationError extends DomainError {
  constructor(
    message = 'You are not allowed to do that.',
    code: Extract<
      DomainErrorCode,
      'FORBIDDEN' | 'NOT_HOST' | 'BANNED' | 'BLOCKED' | 'TRUST_LADDER_VIOLATION' | 'UNAUTHENTICATED'
    > = 'FORBIDDEN',
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, details?: Record<string, unknown>) {
    super('NOT_FOUND', `${what} not found.`, details);
  }
}

export class ConflictError extends DomainError {
  constructor(
    message: string,
    code: DomainErrorCode = 'CONFLICT',
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class RateLimitError extends DomainError {
  constructor(message = 'You are doing that too quickly. Slow down a moment.') {
    super('RATE_LIMITED', message);
  }
}

/**
 * The single source of truth for code -> HTTP status.
 * The socket adapter ignores this and only forwards `code` + `message`.
 */
export function httpStatusForCode(code: DomainErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'UNDERAGE':
    case 'INVALID_CODE':
      return 400;
    case 'UNAUTHENTICATED':
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'FORBIDDEN':
    case 'NOT_HOST':
    case 'BANNED':
    case 'BLOCKED':
    case 'TRUST_LADDER_VIOLATION':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'ROOM_CLOSED':
    case 'ROOM_FULL':
    case 'SPEAKER_SLOTS_FULL':
    case 'ALREADY_REDEEMED':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
    default: {
      const _exhaustive: never = code;
      return 500;
    }
  }
}

/** True for errors we deliberately produced, false for genuine bugs. */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
