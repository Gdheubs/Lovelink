import pino from 'pino';
import type { LogFields, Logger } from '../../domain/ports/Logger.js';

/**
 * ADAPTER: Logger backed by pino.
 *
 * WHY THE REDACTION LIST IS NOT OPTIONAL
 * --------------------------------------
 * The Logger port says "never pass a secret in". This is the second line of
 * defence for when someone does anyway — during an incident, at 3am, adding
 * `log.error({ ...request.body }, 'auth failed')` because they need to see what
 * happened. That one line would otherwise write login codes and refresh tokens
 * into whatever aggregates the logs, permanently.
 *
 * The paths below cover both the top level and one level of nesting, because
 * the accidental-spread case is exactly the nested one.
 */
const REDACTED_PATHS = [
  'code',
  'otp',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'jwt',
  'secret',
  'dob',
  '*.code',
  '*.otp',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.secret',
  '*.dob',
];

export interface PinoLoggerOptions {
  readonly level: string;
  /** Human-readable output for local development; JSON everywhere else. */
  readonly pretty: boolean;
  readonly name?: string;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly instance: pino.Logger) {}

  debug(fields: LogFields, message: string): void {
    this.instance.debug(fields, message);
  }

  info(fields: LogFields, message: string): void {
    this.instance.info(fields, message);
  }

  warn(fields: LogFields, message: string): void {
    this.instance.warn(fields, message);
  }

  error(fields: LogFields, message: string): void {
    this.instance.error(fields, message);
  }

  child(bindings: LogFields): Logger {
    return new PinoLoggerAdapter(this.instance.child(bindings));
  }

  /** Escape hatch for Fastify, which wants the pino instance itself. */
  raw(): pino.Logger {
    return this.instance;
  }
}

export function createLogger(options: PinoLoggerOptions): Logger & { raw(): pino.Logger } {
  const instance = pino({
    level: options.level,
    name: options.name ?? 'loverlink',
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // ISO timestamps: log aggregators and humans both read them, and epoch
    // millis are a needless translation step during an incident.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Ship `level: "info"` rather than `level: 30`. Same reasoning.
      level: (label) => ({ level: label }),
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });

  return new PinoLoggerAdapter(instance) as Logger & { raw(): pino.Logger };
}
