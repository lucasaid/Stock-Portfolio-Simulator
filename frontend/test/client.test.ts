import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../src/api/client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON and sends credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(apiFetch<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
  });

  it('serializes a JSON body with the right header', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await apiFetch('/api/rounds', { method: 'POST', body: { name: 'x' } });

    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.body).toBe('{"name":"x"}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('throws ApiError carrying the status and the server message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'quote is stale' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiFetch('/api/rounds/1/orders', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      message: 'quote is stale',
    });
    await expect(apiFetch('/api/rounds/1/orders', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(apiFetch('/api/rounds')).rejects.toMatchObject({ status: 502 });
  });

  it('marks 401 responses as unauthorized', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiFetch('/api/rounds')).rejects.toMatchObject({ status: 401, unauthorized: true });
  });
});
