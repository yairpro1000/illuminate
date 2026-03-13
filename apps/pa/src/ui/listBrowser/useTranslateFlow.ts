import React from "react";
import type { FieldDef } from "@shared/model";
import { api } from "../../api";
import type { ItemRow, ListInfo } from "./types";
import {
  TRANSLATE_LIST_ID,
  TranslationPayloadZ,
  type TranslationPayload,
} from "../translate";

type CommitFn = (action: any, opts?: { refresh?: boolean; expectedItemUpdatedAt?: string; undoLabel?: string }) => Promise<any>;

export function useTranslateFlow(args: {
  lists: ListInfo[];
  commit: CommitFn;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setErr: React.Dispatch<React.SetStateAction<string | null>>;
  setSearchAllLists: React.Dispatch<React.SetStateAction<boolean>>;
  setListId: React.Dispatch<React.SetStateAction<string>>;
  translateIntent?: string | null;
  onTranslateIntentHandled?: () => void;
}) {
  const {
    lists,
    commit,
    setBusy,
    setErr,
    setSearchAllLists,
    setListId,
    translateIntent,
    onTranslateIntentHandled,
  } = args;
  const [translateOpen, setTranslateOpen] = React.useState(false);
  const [translateRow, setTranslateRow] = React.useState<ItemRow | null>(null);
  const [translateInitial, setTranslateInitial] = React.useState<TranslationPayload | null>(null);

  const rowToTranslationPayload = React.useCallback((row: ItemRow): TranslationPayload => {
    const originLanguage = typeof (row as any).originLanguage === "string" ? String((row as any).originLanguage) : "";
    const destinationLanguage =
      typeof (row as any).destinationLanguage === "string" ? String((row as any).destinationLanguage) : "";
    const originExpression =
      typeof (row as any).originExpression === "string"
        ? String((row as any).originExpression)
        : String((row as any).text ?? "");
    const possibleTranslations = Array.isArray((row as any).possibleTranslations) ? (row as any).possibleTranslations : [];
    const examplesOrigin = Array.isArray((row as any).examplesOrigin) ? (row as any).examplesOrigin : [];
    const examplesDestination = Array.isArray((row as any).examplesDestination) ? (row as any).examplesDestination : [];
    const comments = typeof (row as any).comments === "string" ? String((row as any).comments) : "";
    return {
      originLanguage: originLanguage as any,
      originExpression,
      destinationLanguage: destinationLanguage as any,
      possibleTranslations: possibleTranslations.map((s: any) => String(s ?? "")),
      examplesOrigin: examplesOrigin.map((s: any) => String(s ?? "")),
      examplesDestination: examplesDestination.map((s: any) => String(s ?? "")),
      comments,
    };
  }, []);

  const openTranslateModal = React.useCallback((row: ItemRow, initial?: TranslationPayload) => {
    setTranslateRow(row);
    setTranslateInitial(initial ?? rowToTranslationPayload(row));
    setTranslateOpen(true);
  }, [rowToTranslationPayload]);

  const closeTranslateModal = React.useCallback(() => {
    setTranslateOpen(false);
    setTranslateRow(null);
    setTranslateInitial(null);
  }, []);

  const ensureTranslateListReady = React.useCallback(async () => {
    const requiredFields: Record<string, FieldDef> = {
      originLanguage: { type: "string", nullable: true, description: "Origin language (BCP-47)", ui: { showInPreview: true } },
      originExpression: { type: "string", nullable: true, description: "Origin expression", ui: { showInPreview: true } },
      destinationLanguage: { type: "string", nullable: true, description: "Destination language (BCP-47)", ui: { showInPreview: true } },
      possibleTranslations: { type: "json", nullable: true, description: "Possible translations", ui: { showInPreview: false } },
      examplesOrigin: { type: "json", nullable: true, description: "Examples in origin language", ui: { showInPreview: false } },
      examplesDestination: { type: "json", nullable: true, description: "Examples in destination language", ui: { showInPreview: false } },
      comments: { type: "string", nullable: true, description: "Comments", ui: { showInPreview: false } },
    };

    const existing = lists.find((l) => l.id === TRANSLATE_LIST_ID) ?? null;
    if (!existing) {
      await commit({
        type: "create_list",
        valid: true,
        confidence: 1,
        listId: TRANSLATE_LIST_ID,
        title: "Translate",
        aliases: ["translation", "translations"],
        fields: requiredFields,
      });
      return;
    }

    const missing = Object.entries(requiredFields)
      .filter(([k]) => !existing.fields[k])
      .map(([name, def]) => ({
        name,
        type: def.type,
        ...(Object.prototype.hasOwnProperty.call(def, "default") ? { default: (def as any).default } : {}),
        ...(typeof def.nullable === "boolean" ? { nullable: def.nullable } : {}),
        ...(typeof def.description === "string" ? { description: def.description } : {}),
      }));
    if (missing.length > 0) {
      await commit({
        type: "add_fields",
        valid: true,
        confidence: 1,
        listId: TRANSLATE_LIST_ID,
        fieldsToAdd: missing,
      });
    }
  }, [commit, lists]);

  const llmTranslate = React.useCallback(async (input: string): Promise<TranslationPayload> => {
    const res = await api<{ ok: true; translation: unknown }>("/translate", {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    return TranslationPayloadZ.parse(res.translation);
  }, []);

  const llmRefine = React.useCallback(async (draft: TranslationPayload, question: string) => {
    const res = await api<{ ok: true; translation: unknown; answer: unknown }>("/translate/refine", {
      method: "POST",
      body: JSON.stringify({ draft, question }),
    });
    return { translation: TranslationPayloadZ.parse(res.translation), answer: String((res as any).answer ?? "") };
  }, []);

  const handleTranslateIntentInput = React.useCallback(async (
    input: string,
    extra?: { priority?: number; color?: string | null; status?: string },
  ) => {
    setErr(null);
    setBusy(true);
    try {
      await ensureTranslateListReady();
      const translation = await llmTranslate(input);
      const originExpression = String(translation.originExpression ?? "").trim() || input.trim();
      const result = await commit(
        {
          type: "append_item",
          valid: true,
          confidence: 1,
          listId: TRANSLATE_LIST_ID,
          fields: {
            ...(extra?.priority !== undefined ? { priority: extra.priority } : {}),
            ...(extra?.color != null ? { color: extra.color } : {}),
            ...(extra?.status !== undefined ? { status: extra.status } : {}),
            text: originExpression,
            originLanguage: translation.originLanguage,
            originExpression,
            destinationLanguage: translation.destinationLanguage,
            possibleTranslations: translation.possibleTranslations,
            examplesOrigin: translation.examplesOrigin,
            examplesDestination: translation.examplesDestination,
            comments: translation.comments,
          },
        },
        { refresh: true },
      );
      setSearchAllLists(false);
      setListId(TRANSLATE_LIST_ID);
      const row = result?.item ? ({ ...(result.item as any), __listId: TRANSLATE_LIST_ID } as ItemRow) : null;
      if (row) openTranslateModal(row, translation);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [commit, ensureTranslateListReady, llmTranslate, openTranslateModal, setBusy, setErr, setListId, setSearchAllLists]);

  const saveTranslation = React.useCallback(async (next: TranslationPayload) => {
    if (!translateRow) return;
    const expr = String(next.originExpression ?? "").trim();
    await commit(
      {
        type: "update_item",
        valid: true,
        confidence: 1,
        listId: translateRow.__listId,
        itemId: translateRow.id,
        patch: {
          text: expr || String((translateRow as any).text ?? ""),
          originLanguage: next.originLanguage,
          originExpression: next.originExpression,
          destinationLanguage: next.destinationLanguage,
          possibleTranslations: next.possibleTranslations,
          examplesOrigin: next.examplesOrigin,
          examplesDestination: next.examplesDestination,
          comments: next.comments,
        },
      },
      { undoLabel: `Updated translation: ${expr.slice(0, 40) || "item"}` },
    );
  }, [commit, translateRow]);

  const deleteTranslation = React.useCallback(async () => {
    if (!translateRow) return;
    await commit(
      { type: "delete_item", valid: true, confidence: 1, listId: translateRow.__listId, itemId: translateRow.id },
      { undoLabel: `Deleted translation: ${String((translateRow as any).originExpression ?? translateRow.text ?? "").slice(0, 40)}` },
    );
  }, [commit, translateRow]);

  React.useEffect(() => {
    if (!translateIntent) return;
    onTranslateIntentHandled?.();
    handleTranslateIntentInput(translateIntent);
  }, [handleTranslateIntentInput, onTranslateIntentHandled, translateIntent]);

  return {
    translateOpen,
    translateRow,
    translateInitial,
    openTranslateModal,
    closeTranslateModal,
    ensureTranslateListReady,
    llmTranslate,
    llmRefine,
    handleTranslateIntentInput,
    saveTranslation,
    deleteTranslation,
  };
}
