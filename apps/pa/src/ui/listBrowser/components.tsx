import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { COLOR_PALETTE, STATUS_OPTIONS, STATUS_STYLE, type StatusValue } from "./constants";

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
        border: "1px solid rgba(231, 236, 255, 0.22)",
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
  function choose(v: string | null) {
    props.onChange(v);
    ref.current?.removeAttribute("open");
  }
  return (
    <details className="menu" ref={ref}>
      <summary className="iconbtn" title="Set color" aria-label="Set color">
        {current ? <ColorSwatch color={current} /> : <span className="muted small">No color</span>}
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
  return (
    <details className="menu">
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
              onClick={() => props.onChange(c)}
              title={c}
              aria-label={c}
            >
              <ColorSwatch color={c} size={18} />
            </button>
          ))}
          <button className="swatchBtn" onClick={() => props.onChange(null)} title="Clear" aria-label="Clear">
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

  return (
    <tr ref={setNodeRef} style={style}>
      {props.render({
        dragHandleProps: { ...attributes, ...listeners },
        setDragHandleRef: setActivatorNodeRef as any,
      })}
    </tr>
  );
}

