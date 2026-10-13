import { errors } from "@strapi/utils";

import { auditWriteMode } from "../../../../utils/audit";

/**
 * The audit trail is append-only (decision 06 §H; utils/audit.ts): every
 * query-engine write of an audit row runs one of these hooks (C33), and
 * each refuses unless the recorder (`writer`: creates) or the retention
 * janitor (`janitor`: deletes) is running. Updates are refused always. The
 * Content Manager reads the rows; its create, edit and delete answer 400
 * with the message below. Registered by file convention.
 */

const refuse = (what: string): never => {
  throw new errors.ApplicationError(
    `Audit events are append-only: ${what} is refused (only the audit recorder writes them, ` +
      "only the retention janitor deletes them)",
  );
};

const createsOnlyForTheWriter = (what: string) => () => {
  if (auditWriteMode() !== "writer") refuse(what);
};

const deletesOnlyForTheJanitor = (what: string) => () => {
  if (auditWriteMode() !== "janitor") refuse(what);
};

export default {
  beforeCreate: createsOnlyForTheWriter("creating an audit event"),
  beforeCreateMany: createsOnlyForTheWriter("creating audit events"),
  beforeUpdate: () => refuse("changing an audit event"),
  beforeUpdateMany: () => refuse("changing audit events"),
  beforeDelete: deletesOnlyForTheJanitor("deleting an audit event"),
  beforeDeleteMany: deletesOnlyForTheJanitor("deleting audit events"),
};
