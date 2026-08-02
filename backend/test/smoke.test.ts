import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const sum: number = 1 + 1;
    expect(sum).toBe(2);
  });
});
