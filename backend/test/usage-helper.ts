import type { UsageChecker, UsageSnapshot } from '../src/agent/usage-checker.js';

const NO_DATA: UsageSnapshot = { sessionPct: null, sessionResetsAt: null, weeklyPct: null, weeklyResetsAt: null };

/** Scripted fake usage checker (mirrors FakeAgentRunner): no subprocess, returns a fixed snapshot. */
export class FakeUsageChecker implements UsageChecker {
  calls = 0;

  constructor(private snapshot: UsageSnapshot = NO_DATA) {}

  async checkUsage(): Promise<UsageSnapshot> {
    this.calls++;
    return this.snapshot;
  }
}
