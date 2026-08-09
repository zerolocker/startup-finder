/** Tiny leveled logger. Writes to stderr so stdout stays pipeable. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.SF_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const time = new Date().toISOString().slice(11, 19);
  const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  process.stderr.write(`${time} ${tag} ${msg}${suffix}\n`);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
  /**
   * Progress line that overwrites itself, for long loops.
   * No-ops when stderr is not a TTY — otherwise piping output to a file or to
   * another process produces one line per iteration, which is unreadable.
   */
  progress: (msg: string) => {
    if (threshold > LEVELS.info || !process.stderr.isTTY) return;
    process.stderr.write(`\r\x1b[K   ${msg}`);
  },
  progressDone: () => {
    if (threshold > LEVELS.info || !process.stderr.isTTY) return;
    process.stderr.write('\r\x1b[K');
  },
};
