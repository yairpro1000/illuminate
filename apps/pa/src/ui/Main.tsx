import React from "react";
import { ListBrowser } from "./ListBrowser";
import { VoicePanel } from "./VoicePanel";

export function Main(props: { email: string; llmLabel: string }) {
  const [lastCommittedAt, setLastCommittedAt] = React.useState<number | null>(null);

  return (
    <>
      <div className="container">
        <div className="topbar">
          <div className="kpi">
            <div className="title">PA</div>
            <div className="pill small">
              <span className="muted">User</span>
              <span>{props.email}</span>
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
        </div>

        <VoicePanel onCommitted={() => setLastCommittedAt(Date.now())} />
      </div>

      <div style={{ padding: 18 }}>
        <ListBrowser refreshSignal={lastCommittedAt ?? 0} />
      </div>
    </>
  );
}

