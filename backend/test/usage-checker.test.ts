import { describe, expect, it } from 'vitest';
import { parseUsageResult } from '../src/agent/usage-checker.js';

describe('parseUsageResult', () => {
  it('parses both fixed-format lines from a real captured result', () => {
    const result =
      'Current session: 19% used · resets Aug 4 at 3:20am (Australia/Melbourne)\n' +
      'Current week (all models): 17% used · resets Aug 10 at 11am (Australia/Melbourne)\n';

    const snapshot = parseUsageResult(result);

    expect(snapshot).toEqual({
      sessionPct: 19,
      sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)',
      weeklyPct: 17,
      weeklyResetsAt: 'Aug 10 at 11am (Australia/Melbourne)',
    });
  });

  it('parses lines surrounded by unrelated preface/trailer text', () => {
    const result =
      'Some other status line\n' +
      'Current session: 82% used · resets Aug 4 at 3:20am (Australia/Melbourne)\n' +
      'Current week (all models): 90% used · resets Aug 10 at 11am (Australia/Melbourne)\n' +
      'Another trailing line\n';

    const snapshot = parseUsageResult(result);

    expect(snapshot.sessionPct).toBe(82);
    expect(snapshot.weeklyPct).toBe(90);
  });

  it('leaves weekly fields null when only the session line is present', () => {
    const snapshot = parseUsageResult('Current session: 5% used · resets Aug 4 at 3:20am (Australia/Melbourne)');

    expect(snapshot.sessionPct).toBe(5);
    expect(snapshot.weeklyPct).toBeNull();
    expect(snapshot.weeklyResetsAt).toBeNull();
  });

  it('returns all-null fields for a malformed or truncated result', () => {
    expect(parseUsageResult('')).toEqual({
      sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null,
    });
    expect(parseUsageResult('garbage output, no usage lines here')).toEqual({
      sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null,
    });
    // Truncated mid-line (e.g. a cut-off subprocess pipe) — no "% used" to match.
    expect(parseUsageResult('Current session: 4').sessionPct).toBeNull();
  });

  it('parses a session line with no reset clause', () => {
    const snapshot = parseUsageResult('Current session: 3% used');
    expect(snapshot.sessionPct).toBe(3);
    expect(snapshot.sessionResetsAt).toBeNull();
  });
});
