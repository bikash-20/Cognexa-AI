import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logEvent } from '../lib/logger';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; message?: string };

/**
 * App-level ErrorBoundary. Per Imperative #3, a render crash must NEVER
 * produce a blank white screen. The rest of the app may also be wrapped
 * via RouteErrorBoundary for granular isolation.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logEvent('error.boundary', {
      scope: 'app',
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 6).join('\n'),
      componentStack: info.componentStack?.split('\n').slice(0, 6).join('\n')
    });
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="glass-strong max-w-md p-8 text-center">
            <h1 className="font-display text-2xl text-theme-strong">Something went wrong</h1>
            <p className="mt-2 text-sm text-theme-muted">{this.state.message}</p>
            <button
              type="button"
              className="btn-primary mt-5"
              onClick={() => { this.setState({ hasError: false }); location.reload(); }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
