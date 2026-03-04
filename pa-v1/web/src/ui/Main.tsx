import React from "react";
import { api } from "../api";
import { ListBrowser } from "./ListBrowser";
import { VoicePanel } from "./VoicePanel";

export function Main(props: { username: string; onLoggedOut: () => void; llmLabel: string }) {
  const [lastCommittedAt, setLastCommittedAt] = React.useState<number | null>(null);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    props.onLoggedOut();
  }

  return (
    <>
      <div className="container">
        <div className="topbar">
          <div className="kpi">
            <div className="title">PA V1</div>
            <div className="pill small">
              <span className="muted">User</span>
              <span>{props.username}</span>
            </div>
            <div className="pill small">
              <span className="muted">LLM</span>
              <span>{props.llmLabel}</span>
            </div>
            {lastCommittedAt ? (
              <div className="pill small">
                <span className="muted">Last commit</span>
                <span>{new Date(lastCommittedAt).toLocaleTimeString()}</span>
              </div>
            ) : null}
          </div>
          <div className="btnrow">
            <button onClick={logout}>Sign out</button>
          </div>
        </div>

        <VoicePanel onCommitted={() => setLastCommittedAt(Date.now())} />
      </div>

      <div style={{ padding: 18 }}>
        <ListBrowser refreshSignal={lastCommittedAt ?? 0} />
      </div>
    </>
  );
}
