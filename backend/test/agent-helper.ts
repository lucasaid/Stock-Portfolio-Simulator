import type { AgentRunner, AgentRunRequest, AgentRunResult, AgentToolResult } from '../src/agent/types.js';

export interface ScriptedCall {
  /** Tool name to invoke, with args. */
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Scripted fake Claude (spec §9): executes a fixed list of tool calls against
 * the real handlers, then "responds" with the given text. Captures everything
 * for assertions.
 */
export class FakeAgentRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  toolResults: AgentToolResult[] = [];

  constructor(
    private script: ScriptedCall[] = [],
    private finalText = 'ok',
    private result: Partial<AgentRunResult> = {},
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    for (const call of this.script) {
      const descriptor = request.tools.find((t) => t.name === call.tool);
      if (!descriptor) throw new Error(`scripted tool not offered: ${call.tool}`);
      this.toolResults.push(await descriptor.handler(call.args));
    }
    return {
      status: 'success',
      subtype: 'success',
      text: this.finalText,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0,
      ...this.result,
    };
  }
}
