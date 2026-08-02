import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './shell/AppShell';
import { MarketsPage } from './pages/MarketsPage';
import { NewRoundPage } from './pages/NewRoundPage';
import { RoundDetailPage } from './pages/RoundDetailPage';
import { RoundsPage } from './pages/RoundsPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <AuthProvider>
      <RequireAuth>
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/rounds" replace />} />
            <Route path="/rounds" element={<RoundsPage />} />
            <Route path="/rounds/new" element={<NewRoundPage />} />
            <Route path="/rounds/:id" element={<RoundDetailPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<p>Not found.</p>} />
          </Routes>
        </AppShell>
      </RequireAuth>
    </AuthProvider>
  );
}
