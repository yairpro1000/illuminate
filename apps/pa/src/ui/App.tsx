import React from "react";
import { api } from "../api";
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
      const data = await api<{ user: { email: string } | null }>("/pa/me", { method: "GET" });
      setMe(data);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setMe({ user: null });
    }
  }

  async function loadConfig() {
    try {
      const data = await api<{ llmProvider: string; llmModel: string | null }>("/pa/config", {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const llmLabel =
    config?.llmProvider && config.llmModel
      ? `${config.llmProvider} (${config.llmModel})`
      : config?.llmProvider
        ? config.llmProvider
        : "—";

  if (!me) {
    return (
      <div className="container">
        <div className="card">Loading…</div>
      </div>
    );
  }

  if (!me.user) {
    return (
      <div className="container">
        <div className="topbar">
          <div className="title">PA</div>
          <div className="kpi">
            <div className="pill small">
              <span className="muted">LLM</span>
              <span>{llmLabel}</span>
            </div>
            <div className="muted small">Cloudflare Access • Supabase</div>
          </div>
        </div>
        {err ? <div className="card error">API: {err}</div> : null}
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="title" style={{ marginBottom: 8 }}>
            Access required
          </div>
          <div className="muted small">
            This app is protected by Cloudflare Access. If you can see this page, Access is either not configured for
            this route, or the API is not reachable.
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

