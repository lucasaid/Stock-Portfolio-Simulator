import { createContext, useContext, type ReactNode } from 'react';
import { useMe } from '../api/hooks';
import { ApiError } from '../api/client';

interface AuthState {
  username: string | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ username: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  // A 401 on refetch means the session is gone — logged out, or expired mid-session.
  // react-query keeps the last successful `data` when a refetch fails, so the error
  // has to win here or the shell would keep rendering for a dead session.
  const unauthorized = me.error instanceof ApiError && me.error.unauthorized;
  const value: AuthState = {
    username: unauthorized ? null : me.data?.username ?? null,
    loading: me.isPending,
  };
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
