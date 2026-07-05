/** Minimal leveled logger. Layer tag makes pipeline traces readable. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';

function ts(): string {
  // Wall-clock timestamp for human-readable logs only (not used for logic).
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level: Level, tag: string, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export function logger(tag: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', tag, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', tag, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', tag, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', tag, msg, extra),
  };
}
