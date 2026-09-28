import { afterCommit, inOwnTransaction } from "../../../../utils/after-commit";
import { NOTIFICATION_UID, buildNotification } from "../../../../utils/notify";

interface KudosEvent {
  result?: { id?: number | string | null } | null;
}

export default {
  // After the kudos' transaction commits (LF02), for the same reason as the
  // comment notification: a failing INSERT inside it silently rolled the
  // kudos back on Postgres although the API answered 201.
  async afterCreate(event: KudosEvent) {
    const id = event.result?.id;
    if (id == null) return;
    await afterCommit(
      strapi.db,
      () => notifyRecipient(id),
      (err) => strapi.log.error(`[notifications] failed for kudos: ${(err as Error)?.message}`),
    );
  },
};

/** Re-reads the kudos after the commit; one that is not there notifies nobody. */
async function notifyRecipient(kudosId: number | string): Promise<void> {
  const full = await strapi.db.query("api::kudos.kudos").findOne({
    where: { id: kudosId },
    populate: { from: true, to: true },
  });
  if (!full?.to?.id || !full?.from?.id) return;
  if (full.to.id === full.from.id) return;

  const data = buildNotification({
    type: "kudos",
    titleParts: [{ value: full.from.displayName, fallback: "Someone" }, " gave you kudos!"],
    link: "/kudos",
    recipient: full.to.id,
    actor: full.from.id,
  });
  await inOwnTransaction(strapi.db, () => strapi.db.query(NOTIFICATION_UID).create({ data }));
}
