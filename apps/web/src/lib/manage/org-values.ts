import {
  ORG_FIELDS,
  checkMarkdown,
  checkRequiredString,
  type EditableMedia,
  type OrgAuthoringType,
  type OrgEditorClass,
} from "@sinnlos/domain";
import type { OrgEditable } from "@/lib/api/manage/org";
import { checked, collectFields, done, type BuiltPayload, type FieldRule } from "./payload";
import { coerceDocumentValues } from "./values";

export interface OrgValues {
  description: string;
  color: string;
  image: EditableMedia | null;
  /** admin_role only (v0.22), like every field below: the structure. */
  name: string;
  /** A department's display head (user id), or null. */
  head: number | null;
  /** A team's department (documentId), or "" for none. */
  department: string;
  /** A team's lead (user id), or null. */
  lead: number | null;
  /** A team's members (user ids): sent as the changes against the form's start. */
  members: number[];
}

/** The schema default of a department's color. */
export const DEFAULT_DEPARTMENT_COLOR = "#6366f1";

/** A new department or team (the create pages). */
export function emptyOrgValues(type: OrgAuthoringType): OrgValues {
  return {
    description: "",
    color: type === "department" ? DEFAULT_DEPARTMENT_COLOR : "",
    image: null,
    name: "",
    head: null,
    department: "",
    lead: null,
    members: [],
  };
}

export function orgValuesFromEditable(editable: OrgEditable): OrgValues {
  return {
    description: editable.description ?? "",
    color: "color" in editable ? (editable.color ?? "") : "",
    image:
      "headerImage" in editable
        ? (editable.headerImage ?? null)
        : "avatar" in editable
          ? (editable.avatar ?? null)
          : null,
    name: editable.name,
    head: "head" in editable ? (editable.head?.id ?? null) : null,
    department: "department" in editable ? (editable.department?.documentId ?? "") : "",
    lead: "lead" in editable ? (editable.lead?.id ?? null) : null,
    members: "members" in editable ? (editable.members ?? []).map((person) => person.id) : [],
  };
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/**
 * The raw legacy description is not trimmed, stripped or converted. The
 * structure fields are optional (a head's or lead's form never has them)
 * but must have their type when present.
 */
export function coerceOrgValues(raw: unknown): OrgValues | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.description !== "string" || typeof r.color !== "string") return null;
  const image = coerceDocumentValues({ file: r.image }).file;
  if (r.image != null && image === null) return null;
  const name = r.name ?? "";
  const head = r.head ?? null;
  const department = r.department ?? "";
  const lead = r.lead ?? null;
  const members = r.members ?? [];
  if (
    typeof name !== "string" ||
    (head !== null && !isId(head)) ||
    typeof department !== "string" ||
    (lead !== null && !isId(lead)) ||
    !Array.isArray(members) ||
    !members.every(isId)
  )
    return null;
  return {
    description: r.description,
    color: r.color,
    image,
    name,
    head,
    department,
    lead,
    members: [...new Set(members)],
  };
}

interface OrgPayloadContext {
  mode: "create" | "update";
  initial: OrgValues;
}

export function buildOrgPayload(
  type: OrgAuthoringType,
  roleClass: OrgEditorClass,
  values: OrgValues,
  initial: OrgValues,
  mode: "create" | "update" = "update",
): BuiltPayload {
  const imageKey = type === "department" ? "headerImage" : "avatar";
  const allowed =
    type === "department"
      ? roleClass === "teamLead"
        ? []
        : ORG_FIELDS.department[roleClass]
      : ORG_FIELDS.team[roleClass];
  const rules: FieldRule<OrgValues, OrgPayloadContext>[] = [
    {
      key: "name",
      inputs: ["name"],
      convert: (v) => checked(v.name.trim(), checkRequiredString),
    },
    {
      key: "description",
      inputs: ["description"],
      convert: (v) => checked(v.description.trim() === "" ? null : v.description, checkMarkdown),
    },
    {
      key: "color",
      inputs: ["color"],
      convert: (v) =>
        /^#[0-9a-fA-F]{6}$/.test(v.color) ? { value: v.color } : { code: "invalid" },
    },
    {
      key: imageKey,
      inputs: ["image"],
      same: (a, b) => (a as EditableMedia | null)?.id === (b as EditableMedia | null)?.id,
      convert: (v) => ({ value: v.image?.id ?? null }),
    },
    { key: "head", inputs: ["head"], convert: (v) => ({ value: v.head }) },
    {
      key: "department",
      inputs: ["department"],
      // A new team needs a department; an existing one may lose it (the panel allowed that too).
      convert: (v, ctx) =>
        v.department !== ""
          ? { value: v.department }
          : ctx.mode === "create"
            ? { code: "required" }
            : { value: null },
    },
    { key: "lead", inputs: ["lead"], convert: (v) => ({ value: v.lead }) },
    {
      key: "members",
      inputs: ["members"],
      // Changes, not the list: a membership change made elsewhere meanwhile stays (Codex v0.22).
      convert: (v, ctx) => ({
        value: {
          connect: v.members.filter((id) => !ctx.initial.members.includes(id)),
          disconnect: ctx.initial.members.filter((id) => !v.members.includes(id)),
        },
      }),
    },
  ];
  const { data, fields } = collectFields(new Set(allowed), new Set(), rules, values, initial, {
    mode,
    initial,
  });
  return done(data, fields);
}
