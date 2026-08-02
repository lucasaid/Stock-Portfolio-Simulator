import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunRequest, AgentRunResult } from './types.js';

const SERVER_NAME = 'trading';
const DEFAULT_MAX_TURNS = 6;

/**
 * The only file that touches the Agent SDK. Runs one tightly constrained
 * agentic exchange: no built-in tools, no file/bash/web access, no user or
 * project settings, auto-deny anything outside our in-process tools.
 * Auth comes from ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in process env
 * (the OneCLI gateway injects the real subscription token on the wire).
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
        model: request.model,
        systemPrompt: request.systemPrompt,
        maxTurns: request.maxTurns ?? DEFAULT_MAX_TURNS,
        tools: [],
        mcpServers: { [SERVER_NAME]: server },
        allowedTools: [`mcp__${SERVER_NAME}__*`],
        permissionMode: 'dontAsk',
        settingSources: [],
        // A stray host API key would outrank the proxy token — never inherit it.
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
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
