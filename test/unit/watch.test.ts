import { describe, expect, it } from 'vitest';
import { problems } from '../../src/ops/monitor';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const delivery = (status: string, minutesAgo: number) => ({
  subscriptionName: 's',
  status,
  createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

describe('watch problems()', () => {
  it('ignores delivered and recent pending', () => {
    expect(problems([delivery('delivered', 90), delivery('pending', 3), delivery('processing', 10)], NOW)).toEqual([]);
  });
  it('flags failed, dead-letter and pending older than 10 min', () => {
    const out = problems([delivery('pending', 30), delivery('failed', 1), delivery('dead-letter', 5)], NOW);
    expect(out).toEqual(['s pending (30 min)', 's failed (1 min)', 's dead-letter (5 min)']);
  });
});
