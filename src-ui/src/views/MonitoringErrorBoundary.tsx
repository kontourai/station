import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '../components/state';

class MonitoringErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MonitoringView error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorState
          title="Something went wrong in the monitoring view."
          action={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => this.setState({ hasError: false })}
            >
              Reload
            </button>
          }
        />
      );
    }

    return this.props.children;
  }
}

export function MonitoringViewBoundary({ children }: { children: ReactNode }) {
  return <MonitoringErrorBoundary>{children}</MonitoringErrorBoundary>;
}
