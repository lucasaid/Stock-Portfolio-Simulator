import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useLogout, useUsage } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { KillSwitch } from './KillSwitch';

const LINKS = [
  { to: '/rounds', label: 'Rounds' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/markets', label: 'Markets' },
  { to: '/settings', label: 'Settings' },
];

function UsageGateBanner() {
  const usage = useUsage();
  const status = usage.data;
  if (!status || !status.enabled || (!status.sessionGated && !status.weeklyGated)) return null;

  const parts: string[] = [];
  if (status.sessionGated) {
    const resets = status.snapshot.sessionResetsAt ? ` (resets ${status.snapshot.sessionResetsAt})` : '';
    parts.push(`session usage ${status.snapshot.sessionPct}%${resets}`);
  }
  if (status.weeklyGated) {
    const resets = status.snapshot.weeklyResetsAt ? ` (resets ${status.snapshot.weeklyResetsAt})` : '';
    parts.push(`weekly usage ${status.snapshot.weeklyPct}%${resets}`);
  }

  return (
    <div
      role="status"
      className="panel"
      style={{
        margin: '0.6rem 1rem 0', padding: '0.5rem 0.75rem',
        borderColor: 'var(--loss)', color: 'var(--loss)',
      }}
    >
      AI calls paused — {parts.join(', ')}.
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const logout = useLogout();

  return (
    <>
      <nav
        className="row"
        style={{ justifyContent: 'space-between', padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)' }}
      >
        <span className="row">
          <strong style={{ marginRight: '0.5rem' }}>stake_portfolio</strong>
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              style={({ isActive }) => ({
                color: isActive ? 'var(--accent)' : 'var(--text)',
                textDecoration: 'none',
                fontWeight: isActive ? 600 : 400,
              })}
            >
              {link.label}
            </NavLink>
          ))}
        </span>
        <span className="row">
          <KillSwitch />
          <span className="muted">{username}</span>
          <button onClick={() => logout.mutate()}>Log out</button>
        </span>
      </nav>
      <UsageGateBanner />
      <main style={{ padding: '1rem', maxWidth: 1200, margin: '0 auto' }}>{children}</main>
    </>
  );
}
