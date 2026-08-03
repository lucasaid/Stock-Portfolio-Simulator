export const SERVER_NAME = 'trading';
const DEFAULT_MAX_TURNS = 6;

/** The built-ins a research run may use. Deliberately excludes every filesystem and shell tool. */
export const RESEARCH_TOOLS = ['WebSearch', 'WebFetch'] as const;

export interface RunnerOptionsInput {
  model: string;
  systemPrompt: string;
  maxTurns?: number;
  webTools?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerOptions {
  model: string;
  systemPrompt: string;
  maxTurns: number;
  /** `tools` selects which BUILT-IN tools exist at all; [] means none. */
  tools: string[];
  /** `allowedTools` auto-approves; it does not make a tool available. Both are required. */
  allowedTools: string[];
  permissionMode: 'dontAsk';
  settingSources: never[];
  env: NodeJS.ProcessEnv;
}

/**
 * The single place the agent's capability surface is decided.
 *
 * Two separate SDK options are in play and they are not interchangeable:
 * `tools` is the base set of built-ins that exist for the run, and `allowedTools`
 * is the set that runs without an approval prompt. A built-in listed only in
 * `allowedTools` still does not exist; one listed only in `tools` would block on
 * approval under any permissionMode that prompts.
 */
export function buildRunnerOptions(input: RunnerOptionsInput): RunnerOptions {
  const builtins = input.webTools === true ? [...RESEARCH_TOOLS] : [];
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
    tools: builtins,
    allowedTools: [`mcp__${SERVER_NAME}__*`, ...builtins],
    permissionMode: 'dontAsk',
    settingSources: [],
    // A stray host API key would outrank the proxy token — never inherit it.
    env: { ...(input.env ?? process.env), ANTHROPIC_API_KEY: undefined },
  };
}
