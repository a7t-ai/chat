import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  // A static node, or a render function handed a `reset` so the fallback can offer a retry
  // that re-mounts the subtree. Omit for the small default message below.
  fallback?: ReactNode | ((reset: () => void) => ReactNode);
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// A dependency-free error boundary. Without one, a throw anywhere in the tree (e.g. MapLibre
// blowing up inside the map drawer) unmounts the WHOLE React tree and leaves a dark screen.
// This catches the throw, logs it, and renders a contained fallback instead — so a crashing
// child never takes down its siblings or the app. `reset()` clears the error so the same
// subtree can be re-mounted (e.g. after the user dismisses the panel or hits "try again").
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for debugging without crashing the app.
    console.error("ErrorBoundary caught an error", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") return fallback(this.reset);
      if (fallback !== undefined) return fallback;
      // Default: a small, self-contained message rather than a full-screen takeover.
      return (
        <div className="error-boundary" role="alert">
          <p>Something went wrong.</p>
          <button type="button" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
