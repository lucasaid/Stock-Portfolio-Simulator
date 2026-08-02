import type { ZodRawShape } from 'zod';

export interface AgentToolResult {
  text: string;
  isError?: boolean;
}

/** SDK-agnostic tool description; sdk-runner maps these onto in-process MCP tools. */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<AgentToolResult> | AgentToolResult;
}

export interface AgentRunRequest {
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentToolDescriptor[];
  maxTurns?: number;
}

export interface AgentRunResult {
  status: 'success' | 'error';
  /** SDK result subtype, e.g. 'success', 'error_max_turns'. */
  subtype: string;
  /** Final assistant text (empty on error). */
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
