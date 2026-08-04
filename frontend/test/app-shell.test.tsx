import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/shell/AppShell';
import { AuthProvider } from '../src/auth/AuthProvider';
import { renderWithProviders } from './render';
import { server } from './server';

describe('AppShell usage gate banner', () => {
  it('shows nothing when usage is under threshold', async () => {
    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    await screen.findByText('content');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a banner when session usage is gated', async () => {
    server.use(
      http.get('/api/usage', () =>
        HttpResponse.json({
          snapshot: {
            sessionPct: 92, sessionResetsAt: 'Aug 4 at 3:20am (Australia/Melbourne)',
            weeklyPct: 30, weeklyResetsAt: null,
          },
          enabled: true, sessionThresholdPct: 80, weeklyThresholdPct: 90, sessionGated: true, weeklyGated: false,
        }),
      ),
    );

    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/session usage 92%/i);
    expect(banner).toHaveTextContent(/resets aug 4 at 3:20am/i);
  });

  it('shows nothing when gated but the gate is disabled', async () => {
    server.use(
      http.get('/api/usage', () =>
        HttpResponse.json({
          snapshot: { sessionPct: 99, sessionResetsAt: null, weeklyPct: 99, weeklyResetsAt: null },
          enabled: false, sessionThresholdPct: 80, weeklyThresholdPct: 90, sessionGated: true, weeklyGated: true,
        }),
      ),
    );

    renderWithProviders(
      <AuthProvider>
        <AppShell>content</AppShell>
      </AuthProvider>,
    );

    await screen.findByText('content');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
