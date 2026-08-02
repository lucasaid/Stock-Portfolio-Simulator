import type { ReactNode } from 'react';
import { Spinner } from '../components/Spinner';
import { LoginPage } from './LoginPage';
import { useAuth } from './AuthProvider';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return <Spinner label="Checking session" />;
  if (username === null) return <LoginPage />;
  return <>{children}</>;
}
