import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './shell/AppShell';
import { useEventStream } from './events/useEventStream';
import { useSettings } from './api/hooks';
import { useTheme } from './shell/useTheme';
import { MarketsPage } from './pages/MarketsPage';
import { NewRoundPage } from './pages/NewRoundPage';
import { RoundDetailPage } from './pages/RoundDetailPage';
import { RoundsPage } from './pages/RoundsPage';
import { SettingsPage } from './pages/SettingsPage';

/** Global SSE subscription — only mounted once authenticated. */
function LiveUpdates() {
  useEventStream();
  return null;
}

/** Applies the saved theme app-wide (spec §6.1). */
function ThemeSync() {
  const settings = useSettings();
  useTheme(settings.data?.lookAndFeel);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <RequireAuth>
        <AppShell>
          <LiveUpdates />
          <ThemeSync />
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
