/**
 * Minimal structured JSON logger.
 *
 * Writes straight to stdout (one JSON object per line). Lambda ships stdout to CloudWatch Logs,
 * and pure-JSON lines let CloudWatch Logs Insights query fields such as eventId and correlationId.
 * console.log is avoided because the Lambda runtime prefixes it with plain text.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** Returns a logger that adds `fields` to every entry (e.g. correlationId). */
  child(fields: Fields): Logger;
}

export function serializeError(error: unknown): Fields {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function configuredLevel(): number {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel | 'silent';
  return LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
}

export function createLogger(context: Fields = {}): Logger {
  const write = (level: LogLevel, message: string, fields?: Fields) => {
    if (LEVEL_ORDER[level] < configuredLevel()) return;

    const entry = { timestamp: new Date().toISOString(), level, message, ...context, ...fields };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger({ ...context, ...fields }),
  };
}
