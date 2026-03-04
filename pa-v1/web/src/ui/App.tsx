import React from "react";
import { api } from "../api";
import { Login } from "./Login";
import { Main } from "./Main";

export function App() {
  const [me, setMe] = React.useState<{ user: { username: string } | null } | null>(null);
  const [config, setConfig] = React.useState<{ llmProvider: string; llmModel: string | null } | null>(
    null,
  );
  const [err, setErr] = React.useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const data = await api<{ user: { username: string } | null }>("/api/me", { method: "GET" });
      setMe(data);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setMe({ user: null });
    }
  }

  async function loadConfig() {
    try {
      const data = await api<{ llmProvider: string; llmModel: string | null }>("/api/config", {
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
          <div className="title">PA V1</div>
          <div className="kpi">
            <div className="pill small">
              <span className="muted">LLM</span>
              <span>{llmLabel}</span>
            </div>
            <div className="muted small">Local-only • file-based</div>
          </div>
        </div>
        {err ? <div className="card error">API: {err}</div> : null}
        <Login onLoggedIn={refresh} />
      </div>
    );
  }

  return (
    <Main username={me.user.username} onLoggedOut={refresh} llmLabel={llmLabel} />
  );
}
