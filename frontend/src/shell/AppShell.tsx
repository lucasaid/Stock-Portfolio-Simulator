import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useLogout } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import { KillSwitch } from './KillSwitch';

const LINKS = [
  { to: '/rounds', label: 'Rounds' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/markets', label: 'Markets' },
  { to: '/settings', label: 'Settings' },
];

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
      <main style={{ padding: '1rem', maxWidth: 1200, margin: '0 auto' }}>{children}</main>
    </>
  );
}
