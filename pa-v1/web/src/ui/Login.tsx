import React from "react";
import { api } from "../api";

export function Login(props: { onLoggedIn: () => void }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      props.onLoggedIn();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="title" style={{ marginBottom: 8 }}>
        Sign in
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        First time: run <code>npm run init-auth -- --user admin --pass &quot;...&quot;</code> in{" "}
        <code>pa-v1</code> (writes <code>.env</code>), or set <code>PA_ADMIN_USER</code> +{" "}
        <code>PA_ADMIN_PASS</code>.
      </div>
      <form onSubmit={submit}>
        <div className="row">
          <div className="col">
            <label className="small muted">Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="col">
            <label className="small muted">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }} className="btnrow">
          <button className="primary" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {err ? (
          <div style={{ marginTop: 10 }} className="error small">
            {err}
          </div>
        ) : null}
      </form>
    </div>
  );
}
