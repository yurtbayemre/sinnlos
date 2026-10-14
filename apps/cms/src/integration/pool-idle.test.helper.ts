import type { TestStrapi } from "./harness.test.helper";

/**
 * Waits until the booted cms's database pool is idle before a stop.
 *
 * The Document Service emits its entry events after the commit and does not
 * await them: each one re-reads the entry with a deep populate
 * (@strapi/core 5.57 dist/services/document-service/events.js, `onCommit`).
 * A suite that stops Strapi right after a write destroys the pool under that
 * read, and knex rejects it ("aborted"), an unhandled rejection that fails
 * the run although every test passed. Suites that restart the cms right
 * after writing call this first: three quiet checks 25 ms apart, at most
 * about 10 s.
 *
 * Named *.test.helper.ts like harness.test.helper.ts: not a suite, not part
 * of the cms build.
 */
export async function untilPoolIdle(t: TestStrapi): Promise<void> {
  const pool = (
    t.strapi.db as unknown as {
      connection: { client: { pool?: { numUsed(): number; numPendingAcquires(): number } } };
    }
  ).connection.client.pool;
  if (!pool) return;
  let quiet = 0;
  for (let check = 0; check < 400 && quiet < 3; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = pool.numUsed() === 0 && pool.numPendingAcquires() === 0 ? quiet + 1 : 0;
  }
}
