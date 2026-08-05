import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOptimizerPrompt, OPTIMIZER_SYSTEM_PROMPT, readCodebaseConventions } from '../src/optimizer/prompt.js';

describe('readCodebaseConventions', () => {
  it('extracts the real Hard-won invariants section from this repo\'s own CLAUDE.md', () => {
    const text = readCodebaseConventions();
    expect(text).toContain('Money is integer AUD cents everywhere');
    expect(text).not.toContain('## Claude/auth integration'); // a later section, must not bleed in
  });

  it('falls back to the hardcoded default when the heading is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-test-'));
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, '# Some doc\n\nNo invariants heading here.\n');
    const text = readCodebaseConventions(path);
    expect(text).toContain('integer AUD cents'); // the hardcoded fallback's own wording
  });

  it('falls back to the hardcoded default when the file does not exist', () => {
    const text = readCodebaseConventions('/nonexistent/path/CLAUDE.md');
    expect(text).toContain('integer AUD cents');
  });
});

describe('buildOptimizerPrompt', () => {
  it('renders labelled sections for check-ins, research, scans, and the conventions block', () => {
    const prompt = buildOptimizerPrompt({
      checkins: [{ roundName: 'round A', ts: '2026-08-01T00:00:00Z', status: 'success', actions: ['write_journal'], journalNotes: ['nothing to do'] }],
      briefings: [{ roundName: 'round A', createdAt: '2026-08-01T00:00:00Z', briefing: 'no material news' }],
      scans: [{ roundName: 'round A', createdAt: '2026-08-01T00:00:00Z', detail: 'watchlist now: AAPL', added: ['AAPL'], removed: [] }],
      codebaseConventions: 'FAKE CONVENTIONS TEXT',
    });
    expect(prompt).toContain('round A');
    expect(prompt).toContain('write_journal');
    expect(prompt).toContain('no material news');
    expect(prompt).toContain('watchlist now: AAPL');
    expect(prompt).toContain('FAKE CONVENTIONS TEXT');
  });

  it('renders an explicit empty note for a section with no rows, rather than an empty heading', () => {
    const prompt = buildOptimizerPrompt({ checkins: [], briefings: [], scans: [], codebaseConventions: 'x' });
    expect(prompt.toLowerCase()).toContain('no check-ins');
    expect(prompt.toLowerCase()).toContain('no research');
    expect(prompt.toLowerCase()).toContain('no market scans');
  });
});
