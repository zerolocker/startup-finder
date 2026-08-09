/**
 * The whole persistence layer: newline-delimited JSON files under data/.
 *
 * Why not SQLite? See docs/DECISIONS.md ADR-002. Short version: the data is
 * small (thousands of rows), git gives us free history and diffs, agents can
 * grep it, and there are no native dependencies to break. Revisit past ~50k rows.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { log } from '../util/log.ts';

/** Read every record from a JSONL file. Returns [] if the file is absent. */
export async function readAll<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: T[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A single corrupt line should not lose the rest of the dataset.
      log.warn(`skipping unparseable line ${i + 1} in ${path}`);
    }
  }
  return out;
}

/** Stream records one at a time, for files too large to hold in memory. */
export async function* streamAll<T>(path: string): AsyncGenerator<T> {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      log.warn(`skipping unparseable line in ${path}`);
    }
  }
}

/**
 * Replace a file's contents atomically (write to .tmp, then rename), so an
 * interrupted run can never leave a half-written dataset behind.
 */
export async function writeAll<T>(path: string, records: readonly T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/**
 * Merge new records into a file, deduping by `key`. Later records win, which is
 * what you want when re-ingesting: a Form D amendment should overwrite the
 * original parse, not sit beside it.
 *
 * Returns the number of records that were genuinely new.
 */
export async function upsertAll<T>(
  path: string,
  incoming: readonly T[],
  key: (record: T) => string,
): Promise<{ added: number; updated: number; total: number }> {
  const existing = await readAll<T>(path);
  const byKey = new Map<string, T>();
  for (const record of existing) byKey.set(key(record), record);

  let added = 0;
  let updated = 0;
  for (const record of incoming) {
    const k = key(record);
    if (byKey.has(k)) updated++;
    else added++;
    byKey.set(k, record);
  }

  const merged = [...byKey.values()];
  await writeAll(path, merged);
  return { added, updated, total: merged.length };
}

/** Append records without reading the existing file. Use when keys are unique. */
export async function appendAll<T>(path: string, records: readonly T[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, body, 'utf8');
}
