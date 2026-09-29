import { navItemsFor } from "@/lib/nav-config";
import { getViewer } from "@/lib/viewer";
import { MobileNav } from "./mobile-nav";

/**
 * The phone tab bar with the entries of the viewer's role (FX30, SH02): the
 * role is read on the server per request (getViewer, the render's one
 * /api/me read, shared with the sidebar) and the client nav gets plain data.
 * A component of its own, like the sidebar, so the read runs next to the
 * page instead of in front of it.
 */
export async function ViewerMobileNav() {
  const viewer = await getViewer();
  return <MobileNav items={navItemsFor(viewer.role)} />;
}
