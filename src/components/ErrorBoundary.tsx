import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            padding: 32,
            textAlign: "center",
            color: "var(--text)",
            gap: 16,
          }}
        >
          <p style={{ fontSize: 16, fontWeight: 600 }}>
            Something went wrong
          </p>
          <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
