import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { buildRunnerOptions, SERVER_NAME } from './runner-options.js';
import type { AgentRunner, AgentRunRequest, AgentRunResult } from './types.js';

/**
 * The only file that touches the Agent SDK. Runs one tightly constrained
 * agentic exchange: no built-in tools, no file/bash/web access, no user or
 * project settings, auto-deny anything outside our in-process tools.
 * Auth comes from `pathToClaudeCodeExecutable` (set in runner-options.ts) —
 * the SDK spawns its own bundled `claude` binary as a child process, and that
 * path points at `scripts/onecli-claude-wrapper.sh`, which re-execs the real
 * binary through `onecli run --` so OneCLI injects CLAUDE_CODE_OAUTH_TOKEN
 * into it. The real subscription token never lands in this process's own env.
 */
export class SdkAgentRunner implements AgentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const sdkTools = request.tools.map((descriptor) =>
      tool(descriptor.name, descriptor.description, descriptor.schema, async (args: Record<string, unknown>) => {
        const result = await descriptor.handler(args);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }),
    );
    const server = createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: sdkTools });

    let final: AgentRunResult = {
      status: 'error',
      subtype: 'no_result',
      text: '',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };

    for await (const message of query({
      prompt: request.prompt,
      options: {
        ...buildRunnerOptions({
          model: request.model,
          systemPrompt: request.systemPrompt,
          maxTurns: request.maxTurns,
          webTools: request.webTools,
        }),
        mcpServers: { [SERVER_NAME]: server },
      },
    })) {
      if (message.type === 'result') {
        const success = message.subtype === 'success';
        final = {
          status: success ? 'success' : 'error',
          subtype: message.subtype,
          text: success ? message.result : '',
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          costUsd: message.total_cost_usd,
        };
      }
    }
    return final;
  }
}
