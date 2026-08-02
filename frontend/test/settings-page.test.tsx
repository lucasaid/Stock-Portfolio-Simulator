import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from '../src/pages/SettingsPage';
import { renderWithProviders } from './render';
import { server } from './server';

describe('settings page', () => {
  it('loads each section from the server', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/default starting balance/i)).toHaveValue('50.00'));
    expect(screen.getByLabelText(/ntfy topic/i)).toHaveValue('stake');
    expect(screen.getByLabelText(/^theme/i)).toHaveValue('system');
    expect(screen.getByLabelText(/poll interval/i)).toHaveValue('5');
  });

  it('saves round defaults as cents to the right namespace', async () => {
    let url = '';
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/:namespace', async ({ request }) => {
        url = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    const balance = await screen.findByLabelText(/default starting balance/i);
    await userEvent.clear(balance);
    await userEvent.type(balance, '100');
    await userEvent.click(screen.getByRole('button', { name: /save round defaults/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(url).toBe('/api/settings/roundDefaults');
    expect(body).toMatchObject({ startingBalanceCents: 10000, profitGoalCents: 100000 });
  });

  it('saves integrations including the ntfy toggle', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/settings/integrations', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.click(await screen.findByLabelText(/enable ntfy/i));
    await userEvent.click(screen.getByRole('button', { name: /save integrations/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ ntfy: { enabled: true, topic: 'stake' }, pollIntervalMinutes: 5 });
  });

  it('applies the theme to the document immediately', async () => {
    renderWithProviders(<SettingsPage />);

    await userEvent.selectOptions(await screen.findByLabelText(/^theme/i), 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('saves notification toggles per event kind', async () => {
    let body: Record<string, boolean> | null = null;
    server.use(
      http.put('/api/settings/notifications', async ({ request }) => {
        body = (await request.json()) as Record<string, boolean>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.click(await screen.findByLabelText(/notify on trade/i));
    await userEvent.click(screen.getByRole('button', { name: /save notifications/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.trade).toBe(false);
    expect(body!.skim).toBe(true);
  });

  it('changes the password and reports success', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/auth/password', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.type(await screen.findByLabelText(/current password/i), 'hunter22');
    await userEvent.type(screen.getByLabelText(/new password/i), 'hunter33');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => expect(body).toEqual({ current: 'hunter22', next: 'hunter33' }));
    expect(await screen.findByText(/password changed/i)).toBeInTheDocument();
  });

  it('reports a rejected password change', async () => {
    server.use(
      http.post('/api/auth/password', () => HttpResponse.json({ error: 'current password is wrong' }, { status: 403 })),
    );
    renderWithProviders(<SettingsPage />);

    await userEvent.type(await screen.findByLabelText(/current password/i), 'nope');
    await userEvent.type(screen.getByLabelText(/new password/i), 'hunter33');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('current password is wrong');
  });
});
