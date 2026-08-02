import { useState, type FormEvent } from 'react';
import { useLogin } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';

export function LoginPage() {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    login.mutate({ username, password });
  }

  return (
    <main style={{ maxWidth: 340, margin: '12vh auto' }}>
      <form className="panel grid" onSubmit={onSubmit}>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Sign in</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <ErrorBox error={login.error} />
        <button className="primary" type="submit" disabled={login.isPending}>
          Sign in
        </button>
      </form>
    </main>
  );
}
