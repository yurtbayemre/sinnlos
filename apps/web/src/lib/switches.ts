/**
 * FEATURES_OFF in the web (v0.28, S2 + M11; deep-dive v028-contract-a1.md).
 * One env list switches modules (events, training, marketplace, kudos,
 * celebrations, polls, duty-plans, kpis) and features (read-confirmations,
 * training-reports, search-logging) off; the cms and the web read the same
 * value through the same parser (@sinnlos/domain features.ts).
 *
 * The cms is the enforcement: every route of an off module or feature
 * answers 404 there, so a Server Action or a stale page that still reaches
 * it fails. The web only hides: the nav, the dashboard and manage tiles,
 * the search kinds and the controls; and the proxy answers the pages and
 * route handlers of an off module with the 404 page (switchOfPath), so
 * nothing renders a "cms is down" banner for a module that is simply off.
 *
 * Read per call (the parse is a few string operations), checked once at the
 * start (instrumentation.ts): an unknown value refuses the start like the
 * cms boot. A change needs a restart of both containers anyway.
 */
import { featuresOff, type SwitchName } from "@sinnlos/domain";

/** The switched-off modules and features of this process. */
export function switchedOff(): ReadonlySet<SwitchName> {
  return featuresOff(process.env);
}

export function isOff(name: SwitchName): boolean {
  return switchedOff().has(name);
}

/**
 * The web paths of each switch, by whole path segments. The more specific
 * prefixes come first only for readability: switchOfPath checks them all.
 */
const PATH_SWITCHES: readonly (readonly [prefix: string, name: SwitchName])[] = [
  ["/events", "events"],
  ["/manage/events", "events"],
  ["/training", "training"],
  ["/manage/training", "training"],
  ["/manage/training/report", "training-reports"],
  ["/manage/acknowledgements", "read-confirmations"],
  ["/marketplace", "marketplace"],
  ["/kudos", "kudos"],
  ["/polls", "polls"],
  ["/manage/polls", "polls"],
  ["/duties", "duty-plans"],
  ["/manage/duty-plans", "duty-plans"],
  ["/kpis", "kpis"],
  ["/manage/kpis", "kpis"],
];

/** The first switch in `off` that `pathname` belongs to, or null. */
export function switchOfPath(pathname: string, off: ReadonlySet<SwitchName>): SwitchName | null {
  for (const [prefix, name] of PATH_SWITCHES) {
    if (!off.has(name)) continue;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return name;
  }
  return null;
}
