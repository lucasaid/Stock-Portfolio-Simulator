import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeAgentRunner } from './agent-helper.js';
import type { AgentToolDescriptor } from '../src/agent/types.js';

describe('FakeAgentRunner', () => {
  it('executes scripted tool calls against the offered handlers and records results', async () => {
    const seen: unknown[] = [];
    const echo: AgentToolDescriptor = {
      name: 'echo',
      description: 'echoes',
      schema: { value: z.string() },
      handler: (args) => {
        seen.push(args);
        return { text: `echo:${String(args.value)}` };
      },
    };
    const runner = new FakeAgentRunner([{ tool: 'echo', args: { value: 'hi' } }], 'done');
    const result = await runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [echo] });
    expect(result.status).toBe('success');
    expect(result.text).toBe('done');
    expect(seen).toEqual([{ value: 'hi' }]);
    expect(runner.toolResults).toEqual([{ text: 'echo:hi' }]);
    expect(runner.requests[0]!.prompt).toBe('p');
  });

  it('throws when the script names a tool that was not offered', async () => {
    const runner = new FakeAgentRunner([{ tool: 'ghost', args: {} }]);
    await expect(runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [] })).rejects.toThrow(/ghost/);
  });

  it('supports overriding the result (e.g. error_max_turns)', async () => {
    const runner = new FakeAgentRunner([], '', { status: 'error', subtype: 'error_max_turns' });
    const result = await runner.run({ model: 'm', systemPrompt: 's', prompt: 'p', tools: [] });
    expect(result.subtype).toBe('error_max_turns');
  });
});
