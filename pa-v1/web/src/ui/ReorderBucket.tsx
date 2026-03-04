import React from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ListItem } from "@shared/model";

function SortableRow(props: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div className="draggable" ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span className="muted small">↕</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.label}
        </span>
      </div>
      <span className="muted small">{props.id.slice(0, 8)}</span>
    </div>
  );
}

export function ReorderBucket(props: {
  items: ListItem[];
  priority: number;
  onSave: (orderedIds: string[]) => Promise<void>;
}) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = props.items
      .filter((it) => (it.priority ?? 3) === props.priority)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((it) => it.id);
    setIds(next);
  }, [props.items, props.priority]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await props.onSave(ids);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd(event: any) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(active.id);
    const newIndex = ids.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = ids.slice();
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    setIds(next);
  }

  const itemMap = new Map(props.items.map((it) => [it.id, it]));

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="topbar" style={{ marginBottom: 8 }}>
        <div>
          <div className="title">Reorder (priority {props.priority})</div>
          <div className="muted small">Drag to reorder. Saves to the `order` field.</div>
        </div>
        <div className="btnrow">
          <button className="primary" onClick={save} disabled={busy || ids.length < 2}>
            {busy ? "Saving…" : "Save order"}
          </button>
        </div>
      </div>

      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div>
            {ids.map((id) => (
              <SortableRow key={id} id={id} label={String(itemMap.get(id)?.text ?? "")} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {err ? (
        <div style={{ marginTop: 10 }} className="error small">
          {err}
        </div>
      ) : null}
    </div>
  );
}

