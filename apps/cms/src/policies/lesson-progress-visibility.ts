import { ADMIN } from "../bootstrap/roles";
import { isOff } from "../utils/module-switches";
import { ownRowsFilter } from "../utils/policy-factories";

/**
 * Read-side guard for lesson-progress rows (issue #29) — the same rule as
 * `acknowledgement-visibility`: every role may only list/read its OWN
 * completion receipts; `admin_role` bypasses so the /manage/training
 * report can aggregate across all users. With `training-reports` (or
 * `training`) in FEATURES_OFF (v0.28) the bypass ends: admin_role reads its
 * own receipts only.
 *
 * Progress data is personnel data — a member must not be able to query
 * a colleague's training state (same posture as notifications and
 * RSVPs), and editors get no bypass.
 *
 * The `user` clause references the users-permissions relation, so every
 * role reading progress must also hold `users-permissions.user.find`
 * (validateQuery / throwRestrictedRelations) — all staff roles carry
 * that grant already (see the announcement-visibility notes in
 * docs/architecture.md §6).
 */
export default ownRowsFilter({
  ownerField: "user",
  bypass: [ADMIN],
  bypassWhile: () => !isOff("training-reports"),
});
