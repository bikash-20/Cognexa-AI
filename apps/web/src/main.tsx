import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import { registerSW } from './shared/lib/sw-register';
import { bootstrapTheme } from './shared/lib/theme';
import './shared/ui/global.css';

bootstrapTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000
    },
    mutations: { retry: 0 }
  }
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element missing — check index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);

registerSW();
