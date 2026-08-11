import { describe, expect, it } from 'vitest';
import { resetSpend, spentUsd } from '../src/llm/claude.ts';

/**
 * Cost tracking is an odometer, not a cap (ADR-011). These tests deliberately
 * never call runClaude: with the cap gone there is no longer any way to reach
 * that function without spawning the real CLI, and the suite must stay
 * offline. What is left to pin is that the odometer starts and resets at zero,
 * so a run summary never inherits a previous run's spend.
 */
describe('cost tracking', () => {
  it('starts at zero', () => {
    resetSpend();
    expect(spentUsd()).toBe(0);
  });

  it('is idempotent to reset', () => {
    resetSpend();
    resetSpend();
    expect(spentUsd()).toBe(0);
  });
});
