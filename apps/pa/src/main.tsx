import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { logFrontendError, logFrontendMilestone } from "./observability";
import "./styles.css";

window.addEventListener("pageshow", (e) => {
  const pe = e as PageTransitionEvent;
  if (pe.persisted) window.location.reload();
});

window.addEventListener("error", (event) => {
  void logFrontendError({
    eventType: "uncaught_exception",
    message: event.message || "Unhandled window error",
    error: {
      errorName: event.error?.name || "Error",
      stackTrace: event.error?.stack || null,
      file: event.filename || null,
      lineNumber: event.lineno || null,
      columnNumber: event.colno || null,
      extra: { source: "window.onerror" },
    },
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as Error | string | undefined;
  void logFrontendError({
    eventType: "uncaught_exception",
    message: "Unhandled promise rejection",
    error: {
      errorName: (reason as Error | undefined)?.name || "UnhandledRejection",
      stackTrace: (reason as Error | undefined)?.stack || null,
      extra: {
        reason: typeof reason === "string" ? reason : String((reason as Error | undefined)?.message ?? reason ?? ""),
      },
    },
  });
});

void logFrontendMilestone("page_loaded", { page: "pa" });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
