import { describe, expect, it } from 'vitest';
import { buildRunnerOptions, SERVER_NAME } from '../src/agent/runner-options.js';

describe('buildRunnerOptions', () => {
  const base = { model: 'claude-sonnet-5', systemPrompt: 'sys', maxTurns: 6 };

  it('disables every built-in tool by default', () => {
    const options = buildRunnerOptions(base);
    expect(options.tools).toEqual([]);
  });

  it('allows only the in-process trading tools by default', () => {
    expect(buildRunnerOptions(base).allowedTools).toEqual([`mcp__${SERVER_NAME}__*`]);
  });

  it('enables web search and fetch only when explicitly asked', () => {
    const options = buildRunnerOptions({ ...base, webTools: true });
    // `tools` is what makes a built-in available at all.
    expect(options.tools).toEqual(['WebSearch', 'WebFetch']);
    // `allowedTools` is what stops it prompting for approval.
    expect(options.allowedTools).toContain('WebSearch');
    expect(options.allowedTools).toContain('WebFetch');
    expect(options.allowedTools).toContain(`mcp__${SERVER_NAME}__*`);
  });

  it('never enables a filesystem or shell tool, even with web tools on', () => {
    const withWeb = buildRunnerOptions({ ...base, webTools: true });
    const names = [...(withWeb.tools as string[]), ...withWeb.allowedTools];
    for (const forbidden of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps the non-negotiable lockdown flags in both modes', () => {
    for (const options of [buildRunnerOptions(base), buildRunnerOptions({ ...base, webTools: true })]) {
      expect(options.permissionMode).toBe('dontAsk');
      expect(options.settingSources).toEqual([]);
    }
  });

  it('strips ANTHROPIC_API_KEY from the child environment', () => {
    const options = buildRunnerOptions({ ...base, env: { ANTHROPIC_API_KEY: 'sk-leak', PATH: '/usr/bin' } });
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.PATH).toBe('/usr/bin');
  });

  it('defaults maxTurns and lets the caller raise it for research', () => {
    expect(buildRunnerOptions({ ...base, maxTurns: undefined }).maxTurns).toBe(6);
    expect(buildRunnerOptions({ ...base, maxTurns: 10 }).maxTurns).toBe(10);
  });
});
