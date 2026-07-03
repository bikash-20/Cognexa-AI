import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logEvent } from '../lib/logger';

type Props = { children: ReactNode };
type State = { hasError: boolean; message?: string };

/** Route-scoped ErrorBoundary — keeps the app shell responsive. */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logEvent('error.boundary', { scope: 'route', message: error.message, componentStack: info.componentStack?.split('\n').slice(0,4).join('\n') });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="glass-strong max-w-md p-8 text-center">
            <h2 className="font-display text-xl text-rose-100">This view ran into a problem</h2>
            <p className="mt-2 text-sm text-rose-100/70">{this.state.message}</p>
            <a href="/" className="btn-primary mt-5 inline-block">Back to start</a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
