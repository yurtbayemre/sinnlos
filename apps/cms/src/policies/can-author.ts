import { writeGate } from "../utils/write-gate";

/**
 * global::can-author (deep-dive decision 06 §B2; batch 15 lane 15A): the
 * write gate of v2 authoring on announcement, event, quick-link, document
 * and poll. Every authoring route carries it with its `{ uid }` (and, for
 * the custom actions, its `intent`); a route without a uid gets no class.
 *
 *   - admin_role and editor: the `moderator` class on all five types. No
 *     bypass: their payloads go through the allowlist like everyone's.
 *   - department_head with a `user.department`: the `departmentAuthor`
 *     class on announcement, event and document, and on an existing item
 *     only when every row is owned by their department and in its scope.
 *   - everyone else, and every refused row: false (403) on the generic
 *     create/update and on the list, 404 on the custom document actions.
 *
 * The rules and the loader live in utils/write-gate.ts; the decision
 * travels to the authoring controller on ctx.state.
 */
export default writeGate();
