import { z } from "zod";

export const FieldTypeZ = z.enum(["string", "int", "boolean", "float", "date", "time", "json"]);
export type FieldType = z.infer<typeof FieldTypeZ>;

export const FieldDefZ = z
  .object({
    type: FieldTypeZ,
    default: z.unknown().optional(),
    nullable: z.boolean().optional(),
    description: z.string().optional(),
    ui: z
      .object({
        showInPreview: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();
export type FieldDef = z.infer<typeof FieldDefZ>;

export const ListDefZ = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    aliases: z.array(z.string().min(1)).optional(),
    fields: z.record(FieldDefZ),
    ui: z
      .object({
        defaultSort: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type ListDef = z.infer<typeof ListDefZ>;

export const SchemaRegistryZ = z
  .object({
    version: z.number().int().min(1).default(1),
    lists: z.record(ListDefZ),
  })
  .strict();
export type SchemaRegistry = z.infer<typeof SchemaRegistryZ>;

export const ActionBaseZ = z
  .object({
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const ListTargetFieldsZ = z
  .object({
    listId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  })
  .strict();

export const AppendItemActionZ = z
  .object({
    type: z.literal("append_item"),
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
    listId: ListTargetFieldsZ.shape.listId,
    target: ListTargetFieldsZ.shape.target,
    fields: z.record(z.unknown()),
  })
  .strict();

export const UpdateItemActionZ = z
  .object({
    type: z.literal("update_item"),
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
    listId: ListTargetFieldsZ.shape.listId,
    target: ListTargetFieldsZ.shape.target,
    itemId: z.string().min(1),
    patch: z.record(z.unknown()),
  })
  .strict();

export const DeleteItemActionZ = z
  .object({
    type: z.literal("delete_item"),
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
    listId: ListTargetFieldsZ.shape.listId,
    target: ListTargetFieldsZ.shape.target,
    itemId: z.string().min(1),
  })
  .strict();

export const CreateListActionZ = ActionBaseZ.extend({
  type: z.literal("create_list"),
  listId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  aliases: z.array(z.string().min(1)).optional(),
  fields: z.record(FieldDefZ).optional(),
}).strict();

export const AddFieldsActionZ = ActionBaseZ.extend({
  type: z.literal("add_fields"),
  listId: ListTargetFieldsZ.shape.listId,
  target: ListTargetFieldsZ.shape.target,
  fieldsToAdd: z
    .array(
      z
        .object({
          name: z.string().min(1),
          type: FieldTypeZ,
          default: z.unknown().optional(),
          nullable: z.boolean().optional(),
          description: z.string().optional(),
        })
        .strict(),
    )
    .min(1),
}).strict();

export const MoveItemActionZ = z
  .object({
    type: z.literal("move_item"),
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
    fromListId: z.string().min(1),
    toListId: z.string().min(1),
    itemId: z.string().min(1),
  })
  .strict();

const ParsedActionUnionZ = z.discriminatedUnion("type", [
  AppendItemActionZ,
  UpdateItemActionZ,
  DeleteItemActionZ,
  CreateListActionZ,
  AddFieldsActionZ,
  MoveItemActionZ,
]);

export const ParsedActionZ = ParsedActionUnionZ.superRefine((val, ctx) => {
  if (val.type === "create_list") return;
  if (val.type === "move_item") return;
  const hasTarget = Boolean((val as any).listId || (val as any).target);
  if (!hasTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either listId or target is required.",
      path: ["listId"],
    });
  }
});

export type ParsedAction = z.infer<typeof ParsedActionZ>;

export type ListItem = Record<string, unknown> & {
  id: string;
  createdAt: string;
  text: string;
  priority?: number;
  color?: string | null;
  order?: number;
};

