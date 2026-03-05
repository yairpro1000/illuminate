import React from "react";
import { api } from "../api";
import type { ListItem } from "@shared/model";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableRow } from "./listBrowser/components";

export function ReorderBucket(props: {
  listId: string;
  priority: number;
  items: ListItem[];
  orderedIds: string[];
  onSaved: () => void;
}) {
  const [ids, setIds] = React.useState<string[]>(props.orderedIds);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => setIds(props.orderedIds), [props.orderedIds]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/pa/lists/${encodeURIComponent(props.listId)}/reorder`, {
        method: "POST",
        body: JSON.stringify({ priority: props.priority, orderedIds: ids }),
      });
      props.onSaved();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd(ev: any) {
    const { active, over } = ev;
    if (!over) return;
    if (active.id === over.id) return;
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

