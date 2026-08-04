import { execFile } from 'node:child_process';

export interface UsageSnapshot {
  sessionPct: number | null;
  sessionResetsAt: string | null; // raw display string, e.g. "Aug 4 at 3:20am (Australia/Melbourne)"
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

export interface UsageChecker {
  checkUsage(): Promise<UsageSnapshot>;
}

const NO_DATA: UsageSnapshot = { sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null };

const SESSION_LINE = /^Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/;
const WEEKLY_LINE = /^Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/;

/**
 * Parses the `.result` text block from `claude -p "/usage" --output-format json`. Pure and
 * total: a line that doesn't match either fixed format is ignored, so a malformed or
 * truncated result yields partial or all-null fields, never a throw.
 */
export function parseUsageResult(resultText: string): UsageSnapshot {
  const snapshot: UsageSnapshot = { ...NO_DATA };
  for (const rawLine of resultText.split('\n')) {
    const line = rawLine.trim();
    const session = SESSION_LINE.exec(line);
    if (session) {
      snapshot.sessionPct = Number(session[1]);
      snapshot.sessionResetsAt = session[2]?.trim() ?? null;
      continue;
    }
    const weekly = WEEKLY_LINE.exec(line);
    if (weekly) {
      snapshot.weeklyPct = Number(weekly[1]);
      snapshot.weeklyResetsAt = weekly[2]?.trim() ?? null;
    }
  }
  return snapshot;
}

/**
 * Spawns the same already-authenticated wrapper script the Agent SDK itself uses (see
 * runner-options.ts's CLAUDE_WRAPPER_PATH) for a one-shot, zero-cost `/usage` check. Never
 * throws: any spawn error, non-zero exit, malformed JSON, or timeout resolves to an all-null
 * snapshot, so a broken usage check can never block the app (fail-open lives in
 * UsageGateService, which treats null as "under threshold"). Not unit tested with a real
 * subprocess per the design spec ("no subprocess spawned in any test") — like
 * agent/sdk-runner.ts, this is compile-checked only; parseUsageResult carries the real test
 * coverage.
 */
export class ClaudeCliUsageChecker implements UsageChecker {
  constructor(private wrapperPath: string, private timeoutMs = 10_000) {}

  async checkUsage(): Promise<UsageSnapshot> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          this.wrapperPath,
          ['-p', '/usage', '--output-format', 'json'],
          { timeout: this.timeoutMs },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
      });
      const parsed = JSON.parse(stdout) as { result?: string };
      if (typeof parsed.result !== 'string') return { ...NO_DATA };
      return parseUsageResult(parsed.result);
    } catch {
      return { ...NO_DATA };
    }
  }
}
