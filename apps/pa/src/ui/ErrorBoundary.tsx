import React from "react";
import { logFrontendError } from "../observability";

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    void logFrontendError({
      eventType: "uncaught_exception",
      message: "React error boundary caught an exception",
      error: {
        errorName: error.name,
        stackTrace: error.stack ?? null,
        component: "ErrorBoundary",
        runtime: "react",
        extra: {
          component_stack: info.componentStack ?? "",
        },
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="container">
          <div className="card error">Something went wrong. Reload the page and try again.</div>
        </div>
      );
    }
    return this.props.children;
  }
}
