import { processDiagramCode, processSummaryCode } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

/**
 * Server-side validation of a process's summary and diagram (v1.1) for EVERY
 * writer: the web's /manage form, direct content-API calls, the Document
 * Service and the admin panel. Rules in @sinnlos/domain process.ts (a
 * storage guard: size, XML-legal characters, BPMN root, no DTD; the browser
 * parses and draws). Only a payload that carries the field is checked; a
 * diagram of null is no diagram and passes. Publish re-creates the published
 * row from the stored draft, which validates to itself.
 */
interface ProcessLifecycleEvent {
  params?: { data?: unknown };
}

function check(event: ProcessLifecycleEvent): void {
  const data = event?.params?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const fields = data as Record<string, unknown>;
  if (fields.summary !== undefined) {
    const code = processSummaryCode(fields.summary);
    if (code) throw new errors.ValidationError(`summary: ${code}`);
  }
  if (fields.diagram !== undefined && fields.diagram !== null) {
    const code = processDiagramCode(fields.diagram);
    if (code) throw new errors.ValidationError(`diagram: ${code}`);
  }
}

export default {
  beforeCreate: check,
  beforeUpdate: check,
};
