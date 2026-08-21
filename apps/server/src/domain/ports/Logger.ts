/**
 * PORT: Logger
 *
 * WHY THIS EXISTS
 * ---------------
 * Use cases genuinely need to record that something happened — a ban was
 * issued, a report was filed — and those records are how an incident gets
 * reconstructed. But `pino` is a vendor package, and a use case that imports it
 * cannot be unit-tested without a log sink.
 *
 * The interface is deliberately minimal (four levels, one bindings method).
 * Anything richer — transports, serializers, redaction config — is the
 * adapter's business.
 *
 * INVARIANT: the first argument is a STRUCTURED object, the second a static
 * message. `log.info({ userId }, 'user joined room')` is greppable and
 * queryable; `log.info(\`user ${id} joined\`)` is neither, and it is how you end
 * up unable to answer a question during an outage.
 *
 * SAFETY: never log an OTP, an access or refresh token, a `dob`, or a full
 * `identifier`. The adapter applies redaction as a second line of defence, but
 * the first is not passing them in.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;

  /**
   * Derive a logger that stamps every line with the given fields.
   * Used to attach a request id or socket id once, at the edge, so that every
   * downstream line is correlatable without threading the id through arguments.
   */
  child(bindings: LogFields): Logger;
}

/** A logger that does nothing. Default for tests that do not assert on logs. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
