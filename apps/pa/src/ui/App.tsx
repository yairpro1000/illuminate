import React from "react";
import { api } from "../api";
import { logFrontendMilestone } from "../observability";
import { Main } from "./Main";

export function App() {
  const [me, setMe] = React.useState<{ user: { email: string } | null } | null>(null);
  const [config, setConfig] = React.useState<{ llmProvider: string; llmModel: string | null } | null>(
    null,
  );
  const [err, setErr] = React.useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const data = await api<{ user: { email: string } | null }>("/me", { method: "GET" });
      setMe(data);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setMe({ user: null });
    }
  }

  async function loadConfig() {
    try {
      const data = await api<{ llmProvider: string; llmModel: string | null }>("/config", {
        method: "GET",
      });
      setConfig(data);
    } catch {
      setConfig(null);
    }
  }

  React.useEffect(() => {
    refresh();
    loadConfig();
    void logFrontendMilestone("auth_resolved", { stage: "bootstrap_started" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (me?.user?.email) {
      void logFrontendMilestone("auth_resolved");
    }
  }, [me]);

  const llmLabel =
    config?.llmProvider && config.llmModel
      ? `${config.llmProvider} (${config.llmModel})`
      : config?.llmProvider
        ? config.llmProvider
        : "—";
  const isLocalHost =
    typeof window !== "undefined" &&
    (window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "::1");

  if (!me) {
    if (isLocalHost) {
      return (
        <>
          {err ? (
            <div className="container">
              <div className="card error">API: {err}</div>
            </div>
          ) : null}
          <Main email="local-dev" llmLabel={llmLabel} />
        </>
      );
    }
    return (
      <div className="container">
        <div className="card">Loading…</div>
      </div>
    );
  }

  if (!me.user) {
    if (isLocalHost) {
      return (
        <>
          {err ? (
            <div className="container">
              <div className="card error">API: {err}</div>
            </div>
          ) : null}
          <Main email="local-dev" llmLabel={llmLabel} />
        </>
      );
    }
    return (
      <div className="container">
        <div className="topbar">
          <div className="title">PA</div>
          <div className="kpi">
            <div className="pill small">
              <span className="muted">LLM</span>
              <span>{llmLabel}</span>
            </div>
            <div className="muted small">Supabase</div>
          </div>
        </div>
        {err ? <div className="card error">API: {err}</div> : null}
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="title" style={{ marginBottom: 8 }}>
            Authentication required
          </div>
          <div className="muted small">
            {isLocalHost
              ? "Local API auth was not resolved. Verify apps/api-pa is running with PA_DEV_EMAIL and that GET /api/me returns 200."
              : "Your authenticated session is missing or expired. Reload to continue."}
          </div>
          <div style={{ marginTop: 12 }} className="btnrow">
            <button className="primary" onClick={refresh}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <Main email={me.user.email} llmLabel={llmLabel} />;
}
