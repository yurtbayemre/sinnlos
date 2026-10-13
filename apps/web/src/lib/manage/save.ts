import "server-only";

import { actionFailure } from "@/lib/action-result";
import {
  authorContext,
  authoringWrite,
  isWriteStatus,
  payloadContext,
  payloadFailure,
  saveVerbs,
  validReference,
  type AuthoringActionResult,
} from "./authoring-action";
import { AREA_TYPE, hasDrafts, SCHEDULE_FIELDS, type ManageArea } from "./areas";
import { buildSchedulePayload, type BuiltPayload, type PayloadContext } from "./payload";
import { coerceScheduleValues } from "./values";

/**
 * A save of one /manage form (deep-dive decision 06 §L3, §L4): create or
 * update, as a draft or published, optionally with the schedule of the
 * Schedule… dialog. The area's Server Action hands its values builder; the
 * steps are the same for every area:
 *   1. the capability: create or edit, plus publish for a save that
 *      publishes and schedule for one that schedules;
 *   2. the reference (update): a documentId and the version the form saw;
 *   3. the values, read through the area's coercion (untrusted arguments);
 *   4. the payload: the domain checks and the reject-mode dates, refused
 *      locally with `fields` before any request when a check fails;
 *   5. the request: an explicit `status` (draft or published; polls none),
 *      `If-Match` on an update.
 */

/** What a form sends to its area's save action (every field untrusted). */
export interface SaveInput {
  /** Absent for a create. */
  documentId?: unknown;
  /** The version the form last saw (update). */
  version?: unknown;
  /** "draft" or "published" (explicit types). */
  status?: unknown;
  /** The form's values. */
  values: unknown;
  /** The values the form started from (update): only changed fields are sent. */
  initial?: unknown;
  /** The Schedule… dialog's values (moderators), or absent. */
  schedule?: unknown;
  /** Send the targeting although it did not change (an explicit re-target). */
  retarget?: unknown;
}

const isRecord = (value: unknown): value is SaveInput =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface SaveSpec<V extends object> {
  coerce(raw: unknown): V;
  build(values: V, initial: V | null, ctx: PayloadContext): BuiltPayload;
  /** The announcement's expiry for the schedule check (expiresBeforePublish). */
  expiresAt?(values: V, ctx: PayloadContext): string | null;
}

export async function saveItem<V extends object>(
  area: ManageArea,
  rawInput: SaveInput,
  spec: SaveSpec<V>,
): Promise<AuthoringActionResult> {
  // A Server Action's argument is whatever the client sent: not an object
  // reads as an empty one (refused below), never as a TypeError.
  const input: SaveInput = isRecord(rawInput) ? rawInput : { values: undefined };
  const explicit = hasDrafts(area);
  const mode = input.documentId === undefined || input.documentId === null ? "create" : "update";
  const status = explicit && isWriteStatus(input.status) ? input.status : undefined;
  const schedules =
    input.schedule !== undefined && input.schedule !== null && SCHEDULE_FIELDS[area].length > 0;

  // The capability first (§L3 step 1), then the shape of the request.
  const gate = await authorContext(area, saveVerbs(mode, status === "published", schedules));
  if (!gate.ok) return gate.failure;
  if (explicit && !status) return actionFailure("invalid");
  if (mode === "update" && !validReference(input.documentId, input.version)) {
    return actionFailure("invalid");
  }

  const values = spec.coerce(input.values);
  const initial =
    mode === "update" && input.initial !== undefined && input.initial !== null
      ? spec.coerce(input.initial)
      : null;
  const ctx = payloadContext(gate.context, mode, input.retarget === true);

  const built = spec.build(values, initial, ctx);
  const refused = payloadFailure(built);
  if (refused || !built.ok) return refused ?? actionFailure("invalid");
  let data = built.data;

  if (schedules) {
    const schedule = buildSchedulePayload(
      AREA_TYPE[area],
      coerceScheduleValues(input.schedule),
      ctx,
      { expiresAt: spec.expiresAt?.(values, ctx) ?? null },
    );
    const scheduleRefused = payloadFailure(schedule);
    if (scheduleRefused || !schedule.ok) return scheduleRefused ?? actionFailure("invalid");
    data = { ...data, ...schedule.data };
  }

  return authoringWrite(
    area,
    mode,
    {
      ...(mode === "update"
        ? { documentId: input.documentId as string, version: input.version as string }
        : {}),
      ...(status ? { status } : {}),
      data,
    },
    { refreshPage: mode === "update" },
  );
}
