/**
 * Request-scoped bridge between the wiki-page REST controller and the
 * db-level lifecycle hooks, which have no access to ctx.state.
 *
 * The controller wraps the core update in `wikiEditContext.run(...)`;
 * everything awaited inside — including the beforeUpdate lifecycle that
 * snapshots wiki revisions — can then read the authenticated editor and
 * the optional revision summary via `wikiEditContext.getStore()`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface WikiEditContext {
  editorId?: number;
  revisionSummary?: string;
}

export const wikiEditContext = new AsyncLocalStorage<WikiEditContext>();
