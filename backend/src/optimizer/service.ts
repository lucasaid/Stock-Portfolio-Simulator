import type { DB } from '../db/connection.js';
import { logEvent } from '../db/events.js';
import type { AgentRunner } from '../agent/types.js';
import type { UsageGateService } from '../agent/usage-gate.js';
import type { SettingsStore } from '../settings/store.js';
import { parseActions } from '../analytics/service.js';
import { buildOptimizerPrompt, OPTIMIZER_SYSTEM_PROMPT, readCodebaseConventions } from './prompt.js';

export interface OptimizerDeps {
  db: DB;
  settings: SettingsStore;
  usageGate?: UsageGateService;
}

export interface OptimizerOutcome {
  status: 'success' | 'error' | 'skipped';
  detail: string;
}

export interface OptimizerRunRow {
  id: number;
  created_at: string;
  status: 'success' | 'error';
  web_search_enabled: boolean;
  output: string;
  detail: string;
  tokens_used: number;
  cost_usd: number;
}

const CHECKIN_LIMIT = 200;
const BRIEFING_LIMIT = 50;
const SCAN_LIMIT = 50;
/** Web search means each search is a turn, mirrors ResearchService's RESEARCH_MAX_TURNS. */
const MAX_TURNS_WITH_WEB = 10;
const MAX_TURNS_NO_WEB = 4;

export class OptimizerService {
  private inFlight = false;

  constructor(private deps: OptimizerDeps, private runner: AgentRunner) {}

  async run(webSearch: boolean): Promise<OptimizerOutcome> {
    if (this.inFlight) {
      return { status: 'skipped', detail: 'an optimizer run is already in progress' };
    }
    this.inFlight = true;
    try {
      return await this.runInner(webSearch);
    } finally {
      this.inFlight = false;
    }
  }

  private async runInner(webSearch: boolean): Promise<OptimizerOutcome> {
    const { db, settings } = this.deps;

    if (this.deps.usageGate) {
      const gate = await this.deps.usageGate.check();
      if (!gate.allowed) {
        logEvent(db, 'warn', 'usage_gated', gate.reason!, null);
        return { status: 'skipped', detail: gate.reason! };
      }
    }

    const prompt = buildOptimizerPrompt({
      checkins: this.recentCheckins(),
      briefings: this.recentBriefings(),
      scans: this.recentScans(),
      codebaseConventions: readCodebaseConventions(),
    });

    const model = settings.get('roundDefaults').model;

    try {
      const result = await this.runner.run({
        model,
        systemPrompt: OPTIMIZER_SYSTEM_PROMPT,
        prompt,
        tools: [],
        webTools: webSearch,
        maxTurns: webSearch ? MAX_TURNS_WITH_WEB : MAX_TURNS_NO_WEB,
      });

      const tokens = result.inputTokens + result.outputTokens;
      if (result.status !== 'success' || result.text.trim() === '') {
        return this.record(false, webSearch, `optimizer run failed (${result.subtype})`, '', tokens, result.costUsd);
      }
      return this.record(true, webSearch, `${result.text.trim().split(/\s+/).length} words`, result.text.trim(), tokens, result.costUsd);
    } catch (err) {
      return this.record(false, webSearch, (err as Error).message, '', 0, 0);
    }
  }

  list(limit = 20): OptimizerRunRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd
           FROM optimizer_runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => {
        const r = row as Omit<OptimizerRunRow, 'web_search_enabled'> & { web_search_enabled: number };
        return { ...r, web_search_enabled: Boolean(r.web_search_enabled) };
      });
  }

  private record(
    success: boolean, webSearch: boolean, detail: string, output: string, tokens: number, costUsd: number,
  ): OptimizerOutcome {
    const status = success ? 'success' : 'error';
    this.deps.db
      .prepare(
        `INSERT INTO optimizer_runs (created_at, status, web_search_enabled, output, detail, tokens_used, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), status, webSearch ? 1 : 0, output, detail, tokens, costUsd);

    if (success) {
      logEvent(this.deps.db, 'info', 'optimizer_run', `optimizer run complete: ${detail}`, null);
      return { status: 'success', detail };
    }
    logEvent(this.deps.db, 'warn', 'optimizer_run_failed', `optimizer run failed: ${detail}`, null);
    return { status: 'error', detail };
  }

  private recentCheckins(): { roundName: string; ts: string; status: string; actions: string[]; journalNotes: string[] }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT c.id, c.ts, c.status, c.actions_json, r.name AS round_name
           FROM checkins c JOIN rounds r ON r.id = c.round_id
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(CHECKIN_LIMIT) as { id: number; ts: string; status: string; actions_json: string; round_name: string }[];

    const notesByCheckin = new Map<number, string[]>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const notes = this.deps.db
        .prepare(`SELECT checkin_id, note FROM journal_entries WHERE checkin_id IN (${placeholders})`)
        .all(...ids) as { checkin_id: number; note: string }[];
      for (const n of notes) {
        const list = notesByCheckin.get(n.checkin_id) ?? [];
        list.push(n.note);
        notesByCheckin.set(n.checkin_id, list);
      }
    }

    return rows.map((r) => ({
      roundName: r.round_name,
      ts: r.ts,
      status: r.status,
      actions: parseActions(r.actions_json),
      journalNotes: notesByCheckin.get(r.id) ?? [],
    }));
  }

  private recentBriefings(): { roundName: string; createdAt: string; briefing: string }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT b.created_at, b.briefing, r.name AS round_name
           FROM research_briefings b JOIN rounds r ON r.id = b.round_id
          WHERE b.status = 'success'
          ORDER BY b.id DESC LIMIT ?`,
      )
      .all(BRIEFING_LIMIT) as { created_at: string; briefing: string; round_name: string }[];
    return rows.map((r) => ({ roundName: r.round_name, createdAt: r.created_at, briefing: r.briefing }));
  }

  private recentScans(): { roundName: string; createdAt: string; detail: string; added: string[]; removed: string[] }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT s.created_at, s.detail, s.added_json, s.removed_json, r.name AS round_name
           FROM market_scans s JOIN rounds r ON r.id = s.round_id
          ORDER BY s.id DESC LIMIT ?`,
      )
      .all(SCAN_LIMIT) as { created_at: string; detail: string; added_json: string; removed_json: string; round_name: string }[];
    return rows.map((r) => ({
      roundName: r.round_name,
      createdAt: r.created_at,
      detail: r.detail,
      added: JSON.parse(r.added_json) as string[],
      removed: JSON.parse(r.removed_json) as string[],
    }));
  }
}
