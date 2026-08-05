import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface OptimizerCheckinInput {
  roundName: string;
  ts: string;
  status: string;
  actions: string[];
  journalNotes: string[];
}

export interface OptimizerBriefingInput {
  roundName: string;
  createdAt: string;
  briefing: string;
}

export interface OptimizerScanInput {
  roundName: string;
  createdAt: string;
  detail: string;
  added: string[];
  removed: string[];
}

export interface OptimizerPromptInput {
  checkins: OptimizerCheckinInput[];
  briefings: OptimizerBriefingInput[];
  scans: OptimizerScanInput[];
  codebaseConventions: string;
}

const HEADING = '## Hard-won invariants';

/** A short, hand-written fallback covering the same handful of invariants as CLAUDE.md's own
 * "Hard-won invariants" section, used only if that file/heading can't be read — must never throw. */
const FALLBACK_CONVENTIONS = [
  'Money is integer AUD cents everywhere. No epsilon heuristics in money math.',
  'engine/*, broker/paper.ts, rounds/service.ts, scheduler.ts, db/migrations.ts are hardened files',
  '— touch only with surgical, review-flagged diffs.',
  'Nested config objects (guardrails/fees) deep-merge over defaults, never wholesale-replace.',
  'Analytics and replay code must stay strictly read-only — no INSERT/UPDATE/DELETE.',
].join('\n');

/**
 * Reads this repo's own CLAUDE.md and extracts just the "## Hard-won invariants" section (not
 * the whole ~70KB document, which would dominate token cost). Never throws — a missing file or
 * heading falls back to a short hardcoded default covering the same ground.
 */
export function readCodebaseConventions(
  claudeMdPath: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'CLAUDE.md'),
): string {
  try {
    if (!existsSync(claudeMdPath)) return FALLBACK_CONVENTIONS;
    const text = readFileSync(claudeMdPath, 'utf8');
    const start = text.indexOf(HEADING);
    if (start === -1) return FALLBACK_CONVENTIONS;
    const nextHeadingRelative = text.slice(start + HEADING.length).indexOf('\n## ');
    const end = nextHeadingRelative === -1 ? text.length : start + HEADING.length + nextHeadingRelative;
    const section = text.slice(start, end).trim();
    return section.length > 0 ? section : FALLBACK_CONVENTIONS;
  } catch {
    return FALLBACK_CONVENTIONS;
  }
}

export const OPTIMIZER_SYSTEM_PROMPT = [
  'You are a process auditor for a paper-trading agent app. You read the history of other AI',
  'agent runs (check-ins, research, market scans) and look for repeated, mechanical patterns —',
  'the same tool-call sequence firing every check-in, the same kind of reasoning repeated',
  'verbatim, work that does not actually require judgment — that could be replaced by',
  'deterministic code instead of an LLM call. You do not have any tools: you cannot read the',
  'codebase, place trades, or change anything. Your entire output is read by a human, who may',
  'paste part of it into a separate Claude Code session to implement a change.',
  '',
  'Structure your response in two parts:',
  '1. Findings — the patterns you found and why they look mechanical/repeatable, in plain',
  '   prose. If you found nothing worth automating, say so plainly rather than padding.',
  '2. A section starting with the literal heading "## Implementation prompt", containing a',
  '   single self-contained prompt a developer could paste directly into a fresh Claude Code',
  '   session to implement the change — it must reference the specific hardened-file and',
  '   process constraints given to you below, not generic advice.',
].join('\n');

function checkinsSection(rows: OptimizerCheckinInput[]): string {
  if (rows.length === 0) return 'Recent check-ins:\n(no check-ins in the sampled window)';
  const lines = rows.map(
    (r) => `- [${r.roundName} @ ${r.ts}] status=${r.status} actions=[${r.actions.join(', ')}] journal="${r.journalNotes.join(' / ')}"`,
  );
  return `Recent check-ins:\n${lines.join('\n')}`;
}

function briefingsSection(rows: OptimizerBriefingInput[]): string {
  if (rows.length === 0) return 'Recent research briefings:\n(no research briefings in the sampled window)';
  const lines = rows.map((r) => `- [${r.roundName} @ ${r.createdAt}] "${r.briefing}"`);
  return `Recent research briefings:\n${lines.join('\n')}`;
}

function scansSection(rows: OptimizerScanInput[]): string {
  if (rows.length === 0) return 'Recent market scans:\n(no market scans in the sampled window)';
  const lines = rows.map(
    (r) => `- [${r.roundName} @ ${r.createdAt}] ${r.detail} (added=[${r.added.join(', ')}] removed=[${r.removed.join(', ')}])`,
  );
  return `Recent market scans:\n${lines.join('\n')}`;
}

export function buildOptimizerPrompt(input: OptimizerPromptInput): string {
  return [
    checkinsSection(input.checkins),
    '',
    briefingsSection(input.briefings),
    '',
    scansSection(input.scans),
    '',
    "This codebase's real constraints — any suggestion must respect these:",
    input.codebaseConventions,
  ].join('\n');
}
