import React from "react";
import { ListBrowser } from "./ListBrowser";
import { VoicePanel } from "./VoicePanel";
import { PA_LOGOUT_URL } from "../runtime";

function useThemeToggle() {
  const [isLight, setIsLight] = React.useState(
    () => document.documentElement.classList.contains("theme-light"),
  );
  const toggle = React.useCallback(() => {
    const next = !document.documentElement.classList.contains("theme-light");
    document.documentElement.classList.toggle("theme-light", next);
    try { localStorage.setItem("yb-theme", next ? "light" : "dark"); } catch {}
    setIsLight(next);
  }, []);
  return { isLight, toggle };
}

export function Main(props: { email: string; llmLabel: string }) {
  const [lastCommittedAt, setLastCommittedAt] = React.useState<number | null>(null);
  const [translatePending, setTranslatePending] = React.useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const theme = useThemeToggle();

  const emailLabel = props.email;

  const userButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const userMenuRef = React.useRef<HTMLDivElement | null>(null);

  const doLogout = React.useCallback(async () => {
    setUserMenuOpen(false);

    const isLocalhost =
      window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

    if (isLocalhost) {
      const returnTo = window.location.href;
      const logoutUrl = `${PA_LOGOUT_URL}?returnTo=${encodeURIComponent(returnTo)}`;
      window.location.replace(logoutUrl);
      return;
    }

    try {
      await fetch("/cdn-cgi/access/logout", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
    } finally {
      window.location.replace(window.location.href);
    }
  }, []);

  React.useEffect(() => {
    if (!userMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserMenuOpen(false);
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (userButtonRef.current?.contains(target)) return;
      if (userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [userMenuOpen]);

  return (
    <>
      <div className="container">
        <div className="topbar">
          <div className="kpi">
            <div className="title">PA</div>
            <button
              type="button"
              className="theme-toggle"
              onClick={theme.toggle}
              title="Toggle light/dark mode"
            >
              {theme.isLight ? "Dark" : "Light"}
            </button>
            <div style={{ position: "relative" }}>
              <button
                ref={userButtonRef}
                type="button"
                className="pill small pillButton"
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                onClick={() => setUserMenuOpen((v) => !v)}
              >
                <span className="muted">User</span>
                <span>{emailLabel}</span>
              </button>
              {userMenuOpen && (
                <div
                  ref={userMenuRef}
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: 0,
                    background: "var(--color-bg-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-md)",
                    minWidth: 180,
                    zIndex: 100,
                    boxShadow: "0 12px 40px oklch(0% 0 0 / 0.4)",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item userMenuItem"
                    onClick={doLogout}
                  >
                    Change user
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item userMenuItem"
                    onClick={doLogout}
                  >
                    Logout
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item userMenuItem"
                    title={emailLabel}
                    onClick={() => setUserMenuOpen(false)}
                  >
                    Stay as {emailLabel}
                  </button>
                </div>
              )}
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

        <VoicePanel
          onCommitted={() => setLastCommittedAt(Date.now())}
          onTranslateIntent={(input) => setTranslatePending(input)}
        />
      </div>

      <div className="container">
        <ListBrowser
          refreshSignal={lastCommittedAt ?? 0}
          translateIntent={translatePending}
          onTranslateIntentHandled={() => setTranslatePending(null)}
        />
      </div>
    </>
  );
}
