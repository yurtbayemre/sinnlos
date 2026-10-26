import { lockUserRow, type UserLockHost, type UserLockTrx } from "./mfa-core";

const USER_UID = "plugin::users-permissions.user";

/** The slice of the Strapi instance the write needs (the Entra and OIDC exchange hosts fit). */
export interface UnblockedWriteHost {
  db: {
    query(uid: string): { findOne(params: Record<string, unknown>): Promise<unknown> };
    /** Queries and Document Service calls inside join it (@strapi/database's AsyncLocalStorage). */
    transaction<T>(callback: (scope: { trx: UserLockTrx }) => Promise<T>): Promise<T>;
  } & UserLockHost["db"];
}

/**
 * A write of a user's own row on their behalf (the profile form, the
 * identity provider's profile, department and manager sync) that must not
 * land after the account was blocked or anonymised (v0.28, deep-dive
 * plan-v028-rev3.md R3): the request was authenticated before the block,
 * and its write would otherwise restore a name the anonymisation erased.
 *
 * Runs `write` in its own transaction holding the user's row lock
 * (`FOR UPDATE` on Postgres; SQLite has one writer) and only while the row
 * is not blocked, re-read under that lock. The block takes the same row
 * lock with its UPDATE (utils/user-admin.ts) and the anonymisation locks
 * the row too (utils/anonymise.ts, which also requires the block first), so
 * a write either commits before them or sees `blocked` and writes nothing.
 * A failing write rolls back alone and throws to the caller. Returns
 * whether it wrote.
 */
export async function writeWhileUnblocked(
  strapi: UnblockedWriteHost,
  userId: number,
  write: () => Promise<unknown>,
): Promise<boolean> {
  return strapi.db.transaction(async ({ trx }) => {
    await lockUserRow(strapi, trx, userId);
    const row = (await strapi.db
      .query(USER_UID)
      .findOne({ where: { id: userId }, select: ["id", "blocked"] })) as {
      blocked?: unknown;
    } | null;
    if (!row || row.blocked === true) return false;
    await write();
    return true;
  });
}
