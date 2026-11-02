"use server";

import { refresh } from "next/cache";
import {
  SECRET_RECIPIENTS_QUERY_MAX,
  isSecretShareLifetime,
  isSecretText,
  type SecretShareCreated,
  type SecretShareLifetime,
  type SecretShareRecipient,
  type SecretShareRefusal,
} from "@sinnlos/domain";
import { actionFailure, type ActionResult } from "@/lib/action-result";
import { isDocumentId, isRowId } from "@/lib/entry-id";
import { runSecretAction } from "@/lib/secret-share-errors";
import { strapi, type StrapiDataResponse } from "@/lib/strapi";

/**
 * The secret-share Server Actions (v0.35, plan §3.10). Each one checks its
 * input like the cms does and sends exactly the contract's body (the cms
 * refuses unknown keys, and any body on reveal and revoke). Failures go
 * through runSecretAction, which never logs a response body.
 */

type Result<Data = undefined> = Promise<ActionResult<SecretShareRefusal, Data>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A malformed success answer: a failure without the answer in it. */
function malformed(): never {
  throw new Error("malformed answer");
}

/** Sends a secret; the data is the new share's id (the sender's page shows it). */
export async function createSecret(
  recipient: number,
  text: string,
  lifetime: SecretShareLifetime,
): Result<{ id: string }> {
  if (!isRowId(recipient)) return actionFailure("recipient");
  if (!isSecretText(text)) return actionFailure("text");
  if (!isSecretShareLifetime(lifetime)) return actionFailure("lifetime");
  return runSecretAction(
    "create",
    () =>
      strapi<StrapiDataResponse<SecretShareCreated>>("/api/secret-shares", {
        method: "POST",
        body: JSON.stringify({ data: { recipient, text, lifetime } }),
      }),
    (res) => (isRecord(res?.data) && isDocumentId(res.data.id) ? { id: res.data.id } : malformed()),
  );
}

/**
 * Opens a secret once. The text travels only in this action's result: no
 * refresh() and no redirect, so no rendered page tree ever holds it.
 */
export async function revealSecret(id: string): Result<{ text: string }> {
  if (!isDocumentId(id)) return actionFailure("notFound");
  return runSecretAction(
    "reveal",
    () =>
      strapi<StrapiDataResponse<{ text: unknown }>>(`/api/secret-shares/${id}/reveal`, {
        method: "POST",
      }),
    (res) =>
      isRecord(res?.data) && typeof res.data.text === "string"
        ? { text: res.data.text }
        : malformed(),
  );
}

/** Revokes a pending secret of the caller, then renders the page again. */
export async function revokeSecret(id: string): Result {
  if (!isDocumentId(id)) return actionFailure("notFound");
  const result = await runSecretAction(
    "revoke",
    () => strapi(`/api/secret-shares/${id}/revoke`, { method: "POST" }),
    () => undefined,
  );
  if (result.ok) refresh();
  return result;
}

/** The recipient picker: eligible staff whose name matches `q`, never the caller. */
export async function findSecretRecipients(q: string): Result<SecretShareRecipient[]> {
  if (typeof q !== "string" || Array.from(q).length > SECRET_RECIPIENTS_QUERY_MAX) {
    return actionFailure("invalid");
  }
  return runSecretAction(
    "recipients",
    () =>
      strapi<StrapiDataResponse<SecretShareRecipient[]>>(
        `/api/secret-shares/recipients?q=${encodeURIComponent(q)}`,
      ),
    (res) => (Array.isArray(res?.data) ? res.data : malformed()),
    false,
  );
}
