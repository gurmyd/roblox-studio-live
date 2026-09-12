/**
 * stderr logger. stdout belongs to the MCP stdio transport and must never be
 * written to by anything else in the bridge process.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LEVEL_NAMES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  child(tag: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  tag?: string;
  /** Sink for finished lines (without trailing newline). Defaults to process.stderr. */
  write?: (line: string) => void;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) return fallback;
  const lower = value.toLowerCase() as LogLevel;
  return LEVEL_NAMES.includes(lower) ? lower : fallback;
}

function formatMeta(meta: LogMeta | undefined): string {
  if (!meta) return '';
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      plain[key] = { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
    } else if (value !== undefined) {
      plain[key] = value;
    }
  }
  if (Object.keys(plain).length === 0) return '';
  try {
    return ' ' + JSON.stringify(plain);
  } catch {
    return ' [unserializable meta]';
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_ORDER[level];
  const write = options.write ?? ((line: string) => { process.stderr.write(line + '\n'); });
  const tag = options.tag ?? 'studio-live';

  const emit = (lvl: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    write(`${new Date().toISOString()} [${tag}] ${lvl.toUpperCase()} ${message}${formatMeta(meta)}`);
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (childTag) => createLogger({ ...options, tag: `${tag}:${childTag}` }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
