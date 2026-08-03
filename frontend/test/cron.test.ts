import { describe, expect, it } from 'vitest';
import { CRON_PRESETS, nextRunLabel } from '../src/lib/cron';

describe('cron helpers', () => {
  it('computes the next fire time for a valid expression', () => {
    const now = new Date('2026-08-03T00:00:00Z'); // Monday
    const label = nextRunLabel('30 23 * * 1-5', now);
    expect(label).not.toBeNull();
    expect(label).toMatch(/\d/);
  });

  it('returns null for an unparseable expression', () => {
    expect(nextRunLabel('not a cron expression')).toBeNull();
  });

  it('ships at least one preset per common schedule shape', () => {
    expect(CRON_PRESETS.length).toBeGreaterThan(0);
    for (const preset of CRON_PRESETS) {
      expect(nextRunLabel(preset.expression, new Date('2026-08-03T00:00:00Z'))).not.toBeNull();
    }
  });
});
