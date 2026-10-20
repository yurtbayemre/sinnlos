import { demoAnnouncements } from "./announcements";
import { demoClock } from "./clock";
import { demoDocuments } from "./documents";
import { demoDuties } from "./duties";
import { demoKpis } from "./kpis";
import { demoEvents } from "./events";
import { demoKudos } from "./kudos";
import { demoMarketplace } from "./marketplace";
import { demoNotifications } from "./notifications";
import { demoOrg } from "./org";
import { demoDirectory, demoMe, demoUsers } from "./people";
import { demoPolls } from "./polls";
import { demoTraining } from "./training";
import { demoWiki } from "./wiki";

/** One demo data set: fresh rows, dated relative to `now` in `zone`. */
export function createDemoData(zone: string, now: Date = new Date()) {
  const clock = demoClock(zone, now);
  const users = demoUsers();
  const org = demoOrg(users);
  return {
    users,
    ...org,
    directory: demoDirectory(users, org.departments),
    me: demoMe(users),
    ...demoWiki(users, clock),
    ...demoAnnouncements(users, clock),
    ...demoEvents(users, clock),
    ...demoPolls(users, clock),
    ...demoKudos(users, clock),
    ...demoDocuments(users, clock),
    ...demoDuties(users, clock),
    ...demoKpis(clock),
    ...demoMarketplace(users, clock),
    ...demoNotifications(users, clock),
    ...demoTraining(clock),
  };
}

export type DemoData = ReturnType<typeof createDemoData>;

export interface DemoRequest {
  data: DemoData;
  params: URLSearchParams;
  match: RegExpMatchArray;
  /** A write's JSON body (undefined for a read or a body that is no JSON). */
  body: unknown;
}

export type DemoHandler = (request: DemoRequest) => unknown;
