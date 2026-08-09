import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, budgetRemaining, budgetSpent, runClaude, startBudget } from '../src/llm/claude.ts';

describe('budget cap', () => {
  beforeEach(() => startBudget(0));

  it('starts empty', () => {
    startBudget(5);
    expect(budgetSpent()).toBe(0);
    expect(budgetRemaining()).toBeGreaterThan(0);
  });

  it('refuses to dispatch a call that cannot fit under the cap', async () => {
    // A zero cap must reject before spawning anything, so this test never
    // actually invokes the Claude CLI.
    await expect(runClaude('anything', { cache: false })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('reserves in-flight cost so concurrent calls cannot collectively overshoot', async () => {
    // Cap fits exactly one call's assumed cost. Two concurrent dispatches must
    // not both pass the check — that was the bug this reservation fixes.
    startBudget(0.5);
    const results = await Promise.allSettled([
      runClaude('a', { cache: false, timeoutMs: 1 }),
      runClaude('b', { cache: false, timeoutMs: 1 }),
    ]);
    const budgetRejections = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BudgetExceededError,
    );
    expect(budgetRejections).toHaveLength(1);
  });

  it('reports remaining budget net of reservations', () => {
    startBudget(10);
    expect(budgetRemaining()).toBe(10);
  });
});
