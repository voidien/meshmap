import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** If something in the app throws while drawing, show what happened and a way back, rather than a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("meshmap crashed while drawing:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot err" role="alert" id="crash-screen" style={{ padding: 24, maxWidth: 640 }}>
        <h2>Something went wrong</h2>
        <p>The page hit an error and stopped drawing. Changes saved before this are safe; the last few seconds of edits may not have been saved.</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{this.state.error.message}</pre>
        <p>
          <button className="on" onClick={() => location.reload()}>
            Reload the page
          </button>
        </p>
      </div>
    );
  }
}
