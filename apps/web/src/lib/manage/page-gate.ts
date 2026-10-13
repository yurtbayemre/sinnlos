import "server-only";

import { redirect } from "next/navigation";
import { capabilitiesFor, type AuthoringVerb, type Capabilities } from "@/lib/roles";
import { getViewer, type Viewer } from "@/lib/viewer";
import { areaAccess, canDo, type AreaAccess } from "./access";
import { AREA_PATH, type ManageArea } from "./areas";

/**
 * The gates of the /manage pages (deep-dive decision 06 §L1, §L2): the
 * shell needs `capabilities.manage` (the layout checks it), an area page
 * its `author[area]`, a create page `create` and an edit page `edit`. The
 * role is read per request (getViewer, D-SESSION-01), so a demoted author
 * loses the pages on the next request. UX only: the cms decides every read
 * and write; a department author's rows come from their own authoringList.
 */

export interface ManageGate {
  viewer: Viewer;
  capabilities: Capabilities;
}

export interface AreaGate extends ManageGate {
  access: AreaAccess;
}

/** The /manage shell: redirects home without `manage`. */
export async function manageGate(): Promise<ManageGate> {
  const viewer = await getViewer();
  const capabilities = capabilitiesFor(viewer.role);
  if (!capabilities.manage) redirect("/");
  return { viewer, capabilities };
}

/**
 * An area page: redirects to /manage without access to the area, and to
 * the area's list without `verb`.
 */
export async function areaGate(area: ManageArea, verb?: AuthoringVerb): Promise<AreaGate> {
  const gate = await manageGate();
  const access = areaAccess(gate.capabilities, area);
  if (!access) redirect("/manage");
  if (verb && !canDo(access, verb)) redirect(AREA_PATH[area]);
  return { ...gate, access };
}
