import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { COLOR_PALETTE, STATUS_OPTIONS, STATUS_STYLE, type StatusValue } from "./constants";

export function useDismissibleDetails(ref: React.RefObject<HTMLDetailsElement | null>) {
  React.useEffect(() => {
    const el = ref.current;

    function close() {
      ref.current?.removeAttribute("open");
    }

    function onPointerDown(e: PointerEvent) {
      const el = ref.current;
      if (!el) return;
      if (!el.open) return;
      const target = e.target as Node | null;
      if (target && el.contains(target)) return;
      close();
    }

    function onKeyDown(e: KeyboardEvent) {
      const el = ref.current;
      if (!el) return;
      if (!el.open) return;
      if (e.key === "Escape") { close(); return; }
    }

    function onToggle() {
      const el = ref.current;
      if (!el || !el.open) return;
      const panel = el.querySelector(":scope > .menuPanel") as HTMLElement | null;
      if (!panel) return;

      const rect = el.getBoundingClientRect();
      const panelH = panel.offsetHeight;
      const panelW = panel.offsetWidth;

      // Vertical: prefer below, flip up if not enough space
      const spaceBelow = window.innerHeight - rect.bottom;
      let y = spaceBelow >= panelH + 10 || rect.top < panelH + 10
        ? rect.bottom + 6
        : rect.top - panelH - 6;
      y = Math.max(8, Math.min(y, window.innerHeight - panelH - 8));

      // Horizontal: right-align to trigger, clamp to viewport
      let x = rect.right - panelW;
      x = Math.max(8, Math.min(x, window.innerWidth - panelW - 8));

      el.style.setProperty("--menu-y", `${y}px`);
      el.style.setProperty("--menu-x", `${x}px`);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    el?.addEventListener("toggle", onToggle);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      el?.removeEventListener("toggle", onToggle);
    };
  }, [ref]);
}

export function ColorSwatch(props: { color: string; size?: number }) {
  const size = props.size ?? 14;
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 6,
        background: props.color,
        border: "1px solid var(--color-border)",
      }}
    />
  );
}

export function StatusBadge(props: { value: StatusValue }) {
  const s = STATUS_STYLE[props.value];
  return (
    <span
      className="statusBadge"
      style={{ background: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {s.label}
    </span>
  );
}

export function ColorPicker(props: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  const current = typeof props.value === "string" && props.value ? props.value : null;
  const ref = React.useRef<HTMLDetailsElement | null>(null);
  useDismissibleDetails(ref);

  function choose(v: string | null) {
    props.onChange(v);
    ref.current?.removeAttribute("open");
  }
  return (
    <details className="menu" ref={ref}>
      <summary className="iconbtn" title="Set color" aria-label="Set color" style={{ width: 32, height: 32, padding: 0 }}>
        <ColorSwatch color={current ?? "var(--bg)"} size={14} />
      </summary>
      <div className="menuPanel" style={{ minWidth: 220 }}>
        <div className="swatchGrid">
          {COLOR_PALETTE.map((c) => (
            <button key={c} className="swatchBtn" onClick={() => choose(c)} title={c} aria-label={c}>
              <ColorSwatch color={c} size={18} />
            </button>
          ))}
          <button className="swatchBtn" onClick={() => choose(null)} title="Clear" aria-label="Clear">
            <span className="muted small">×</span>
          </button>
        </div>
      </div>
    </details>
  );
}

export function StatusPicker(props: {
  value: unknown;
  archived: boolean;
  onChange: (v: StatusValue) => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  const ref = React.useRef<HTMLDetailsElement | null>(null);
  useDismissibleDetails(ref);
  const current: StatusValue = STATUS_OPTIONS.includes(props.value as any)
    ? (props.value as StatusValue)
    : "todo";
  function choose(v: StatusValue) {
    props.onChange(v);
    ref.current?.removeAttribute("open");
  }
  function close() {
    ref.current?.removeAttribute("open");
  }
  return (
    <details className="menu" ref={ref}>
      <summary className="iconbtn" title="Set status" aria-label="Set status">
        <StatusBadge value={current} />
      </summary>
      <div className="menuPanel">
        {STATUS_OPTIONS.map((s) => (
          <button key={s} className="menuItem" onClick={() => choose(s)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StatusBadge value={s} />
            </span>
          </button>
        ))}
        <div className="menuSep" />
        {props.archived ? (
          <button
            className="menuItem"
            onClick={() => {
              close();
              props.onUnarchive();
            }}
          >
            Unarchive
          </button>
        ) : (
          <button
            className="menuItem"
            onClick={() => {
              close();
              props.onArchive();
            }}
          >
            Archive
          </button>
        )}
      </div>
    </details>
  );
}

export function StatusSelect(props: { value: StatusValue; onChange: (v: StatusValue) => void }) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as StatusValue)}>
      {STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {STATUS_STYLE[s].label}
        </option>
      ))}
    </select>
  );
}

export function ColorSelect(props: { value: string | null; onChange: (v: string | null) => void }) {
  const ref = React.useRef<HTMLDetailsElement | null>(null);
  useDismissibleDetails(ref);

  return (
    <details className="menu" ref={ref}>
      <summary className="iconbtn" style={{ width: "100%", justifyContent: "space-between" }}>
        <span className="muted small">{props.value ? "Color" : "No color"}</span>
        {props.value ? <ColorSwatch color={props.value} /> : <span className="muted small">—</span>}
      </summary>
      <div className="menuPanel" style={{ minWidth: 240 }}>
        <div className="swatchGrid">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              className="swatchBtn"
              onClick={() => {
                props.onChange(c);
                ref.current?.removeAttribute("open");
              }}
              title={c}
              aria-label={c}
            >
              <ColorSwatch color={c} size={18} />
            </button>
          ))}
          <button
            className="swatchBtn"
            onClick={() => {
              props.onChange(null);
              ref.current?.removeAttribute("open");
            }}
            title="Clear"
            aria-label="Clear"
          >
            <span className="muted small">×</span>
          </button>
        </div>
      </div>
    </details>
  );
}

export function ToggleSwitch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      disabled={props.disabled}
    >
      <span className={props.checked ? "switchTrack on" : "switchTrack"}>
        <span className={props.checked ? "switchThumb on" : "switchThumb"} />
      </span>
    </button>
  );
}

export function SortableTr(props: {
  id: string;
  disabled: boolean;
  fullRowDrag?: boolean;
  render: (args: { dragHandleProps: any; setDragHandleRef: (el: HTMLElement | null) => void }) => React.ReactNode;
  style?: React.CSSProperties;
}) {
  const { setNodeRef, attributes, listeners, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: props.id,
      disabled: props.disabled,
    });

  const style: React.CSSProperties = {
    ...(props.style ?? {}),
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.75 : 1,
  };

  const rowProps = props.fullRowDrag ? { ...attributes, ...listeners } : {};

  return (
    <tr ref={setNodeRef} style={style} {...rowProps}>
      {props.render({
        dragHandleProps: props.fullRowDrag ? {} : { ...attributes, ...listeners },
        setDragHandleRef: props.fullRowDrag ? () => {} : (setActivatorNodeRef as any),
      })}
    </tr>
  );
}
