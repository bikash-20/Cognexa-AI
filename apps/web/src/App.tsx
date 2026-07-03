import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LandingPage } from './features/landing/LandingPage';
import { RouteErrorBoundary } from './shared/ui/RouteErrorBoundary';

const ChatPage = lazy(() =>
  import('./features/chat/ChatPage').then((m) => ({ default: m.ChatPage }))
);
const VoicePage = lazy(() =>
  import('./features/voice/VoicePage').then((m) => ({ default: m.VoicePage }))
);

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/chat"
        element={
          <RouteErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <ChatPage />
            </Suspense>
          </RouteErrorBoundary>
        }
      />
      <Route
        path="/voice"
        element={
          <RouteErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <VoicePage />
            </Suspense>
          </RouteErrorBoundary>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full min-h-screen items-center justify-center">
      <div
        className="h-10 w-10 animate-orb-pulse rounded-full shadow-glass-lg"
        style={{ background: 'linear-gradient(135deg, var(--accent-from), var(--accent-to))' }}
      />
    </div>
  );
}
