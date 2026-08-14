/**
 * Tiny leveled logger. Writes to stderr so stdout stays pipeable.
 *
 * A run can also tee everything to a file (see `startFileLog`). That matters
 * because the interesting runs are the unattended ones: a scheduled routine
 * fires, hits the plan's rate limit somewhere in the middle, and stops. By the
 * time anyone looks, the terminal output is gone. `data/index.json` records what
 * a run *achieved* but not *why it stopped*, and telling "the limit stopped it
 * cleanly" from "everything failed for some other reason" is the whole question.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env['SF_LOG_LEVEL'] as Level) ?? 'info'] ?? LEVELS.info;

let logFile: string | null = null;

/**
 * Tee every subsequent log line to `path`, in addition to stderr.
 *
 * Appends rather than truncates: several runs a day is the intended usage, and
 * losing the earlier one would defeat the point. Written synchronously so a
 * crash or a kill still leaves the lines that led up to it on disk.
 */
export function startFileLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
  const stamp = new Date().toISOString();
  appendFileSync(path, `\n${'='.repeat(72)}\n=== run started ${stamp}\n${'='.repeat(72)}\n`);
}

export function logFilePath(): string | null {
  return logFile;
}

function emit(level: Level, msg: string, extra?: unknown): void {
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;

  // The file gets full ISO timestamps and every level regardless of the console
  // threshold — a log you read days later needs dates, and debug lines are
  // exactly what you want when something went wrong unattended.
  if (logFile) {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${tag} ${msg}${suffix}\n`);
    } catch {
      // Never let logging break a run.
    }
  }

  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
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
