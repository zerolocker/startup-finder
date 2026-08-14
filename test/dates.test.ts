import { describe, expect, it } from 'vitest';
import { datesToCover } from '../src/cli.ts';
import type { RunIndexEntry } from '../src/types.ts';

const entry = (date: string, companies: number, assessed: number): RunIndexEntry => ({
  date, windowDays: 1, companies, assessed, costUsd: 0, generatedAt: '',
});

// `sf run` is the only command a routine calls, so the set of days it covers
// has to be right without anyone passing arguments.
describe('datesToCover', () => {
  const TODAY = new Date('2026-08-12T09:00:00Z');

  // EDGAR publishes a day's index only after that day closes.
  it('targets yesterday, never today', () => {
    expect(datesToCover([entry('2026-08-10', 5, 5)], TODAY)).toEqual(['2026-08-11']);
  });

  // Catching up is defined relative to a known last issue. With no history,
  // walking back the whole window would research ~430 companies on first use.
  it('runs yesterday alone on a first run, rather than a week', () => {
    expect(datesToCover([], TODAY)).toEqual(['2026-08-11']);
  });

  it('backfills days missed since the last complete issue, newest first', () => {
    // Newest first: a rate limit usually truncates the run, and the most recent
    // issue is the one worth having complete.
    expect(datesToCover([entry('2026-08-08', 5, 5)], TODAY)).toEqual([
      '2026-08-11', '2026-08-10', '2026-08-09',
    ]);
  });

  // Resuming after a rate limit and backfilling a missed day are the same
  // operation — an incomplete issue is just a day with unassessed companies.
  it('re-covers a day that was left half researched', () => {
    expect(datesToCover([entry('2026-08-11', 62, 25)], TODAY)).toContain('2026-08-11');
  });

  it('does nothing when yesterday is already complete', () => {
    expect(datesToCover([entry('2026-08-11', 62, 62)], TODAY)).toEqual([]);
  });

  // A long gap must not fan out into an unbounded run.
  it('caps a long absence at a week', () => {
    expect(datesToCover([entry('2025-01-01', 5, 5)], TODAY)).toHaveLength(7);
  });

  it('treats an empty issue as not complete, so it is retried', () => {
    expect(datesToCover([entry('2026-08-11', 0, 0)], TODAY)).toContain('2026-08-11');
  });
});
