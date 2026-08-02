import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import App from '../src/App';
import { renderWithProviders } from './render';
import { server } from './server';

function unauthenticated(): void {
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })));
}

describe('authentication', () => {
  it('shows the login page when there is no session', async () => {
    unauthenticated();
    renderWithProviders(<App />, '/rounds');

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('surfaces a failed login without navigating away', async () => {
    unauthenticated();
    server.use(http.post('/api/auth/login', () => HttpResponse.json({ error: 'invalid credentials' }, { status: 401 })));
    renderWithProviders(<App />, '/rounds');

    await userEvent.type(await screen.findByLabelText(/username/i), 'chris');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('invalid credentials')).toBeInTheDocument();
  });

  it('renders the shell for an authenticated user', async () => {
    renderWithProviders(<App />, '/rounds');

    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('chris')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /markets/i })).toBeInTheDocument();
  });

  it('returns to the login page after logout', async () => {
    let authed = true;
    server.use(
      http.get('/api/auth/me', () =>
        authed ? HttpResponse.json({ username: 'chris' }) : HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
      http.post('/api/auth/logout', () => {
        authed = false;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<App />, '/rounds');

    await userEvent.click(await screen.findByRole('button', { name: /log out/i }));

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('asks for confirmation before the kill switch fires', async () => {
    let killed = false;
    server.use(
      http.post('/api/kill', () => {
        killed = true;
        return HttpResponse.json({ paused: 2 });
      }),
    );
    renderWithProviders(<App />, '/rounds');

    await userEvent.click(await screen.findByRole('button', { name: /kill switch/i }));
    expect(killed).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /pause all rounds/i }));
    await waitFor(() => expect(killed).toBe(true));
  });
});
