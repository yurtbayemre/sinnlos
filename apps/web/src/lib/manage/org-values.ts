import {
  ORG_FIELDS,
  checkMarkdown,
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
  };
}

/** The raw legacy description is not trimmed, stripped or converted. */
export function coerceOrgValues(raw: unknown): OrgValues | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.description !== "string" || typeof r.color !== "string") return null;
  const image = coerceDocumentValues({ file: r.image }).file;
  if (r.image != null && image === null) return null;
  return { description: r.description, color: r.color, image };
}

export function buildOrgPayload(
  type: OrgAuthoringType,
  roleClass: OrgEditorClass,
  values: OrgValues,
  initial: OrgValues,
): BuiltPayload {
  const imageKey = type === "department" ? "headerImage" : "avatar";
  const allowed =
    type === "department"
      ? roleClass === "teamLead"
        ? []
        : ORG_FIELDS.department[roleClass]
      : ORG_FIELDS.team[roleClass];
  const rules: FieldRule<OrgValues, { mode: "update" }>[] = [
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
  ];
  const { data, fields } = collectFields(new Set(allowed), new Set(), rules, values, initial, {
    mode: "update",
  });
  return done(data, fields);
}
