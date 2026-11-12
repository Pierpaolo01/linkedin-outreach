/**
 * LinkedIn for `npm start` with `LINKEDIN_DRIVER=fake`: a simulated LinkedIn in memory, with a few
 * dozen invented members behind My Network → Grow and one people search, and the fake AI. Nothing
 * here touches LinkedIn or calls an AI, so outreach is on: every send is pretend.
 *
 * The world lives as long as the process; a restart starts a new one with the same members.
 */
import { createFakeAi } from "../ai/fakeAi";
import type { Ai } from "../ai/types";
import type { Clock, Driver, RandomSource } from "../engine/ports";
import { FakeWorld, type MemberSpec } from "../linkedin/fake/world";

/** The one people search the fake LinkedIn knows. Paste it as a campaign's search URL. */
export const DEMO_SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=impresa%20edile";

const DAY_MS = 86_400_000;

const FIRST_NAMES = ["Marco", "Giulia", "Luca", "Francesca", "Andrea", "Chiara", "Matteo", "Sara", "Davide", "Elena", "Paolo", "Martina"];
const LAST_NAMES = ["Rossi", "Bianchi", "Ferrari", "Esposito", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti"];
const CITIES = ["Milano", "Torino", "Bologna", "Verona", "Bergamo", "Brescia", "Padova", "Firenze"];
const ROLES = [
  { title: "Titolare", company: "Edilizia", headline: "Owner of a construction company" },
  { title: "Founder", company: "Impianti", headline: "Founder, electrical installations for homes and offices" },
  { title: "CEO", company: "Serramenti", headline: "CEO of a family business making windows and doors" },
  { title: "Marketing manager", company: "Group", headline: "Marketing manager at a large retail group" },
  { title: "Software engineer", company: "Tech", headline: "Software engineer building web apps" },
  { title: "Amministratore", company: "Costruzioni", headline: "Construction company owner, renovations and new builds" },
] as const;

const MEMBERS = 36;

function member(n: number): MemberSpec {
  const first = FIRST_NAMES[n % FIRST_NAMES.length] ?? "Marco";
  const last = LAST_NAMES[(n * 5) % LAST_NAMES.length] ?? "Rossi";
  const role = ROLES[n % ROLES.length] ?? ROLES[0];
  const city = CITIES[n % CITIES.length] ?? "Milano";
  return {
    publicId: `demo-${first.toLowerCase()}-${last.toLowerCase()}-${n}`,
    memberId: `ACoADemoMember${n}`,
    fullName: `${first} ${last}`,
    headline: role.headline,
    location: `${city}, Italia`,
    currentTitle: role.title,
    currentCompany: `${last} ${role.company} S.r.l.`,
    degree: n % 9 === 0 ? 3 : 2,
    // Most accept within a day or two, some never; a few reply, one writes first.
    acceptsAfterHours: n % 4 === 3 ? null : 4 + (n % 5) * 9,
    repliesAfterHours: n % 3 === 0 ? 6 + n : null,
    ...(n === 7 ? { repliesBeforeFirstMessageAfterHours: 1 } : {}),
    ...(n % 11 === 5 ? { connectInMore: true } : {}),
  };
}

export interface FakeLinkedIn {
  readonly world: FakeWorld;
  /** A new driver handle on the same world, as a new process would have. */
  readonly driver: () => Driver;
  readonly outreach: true;
  readonly ai: () => Ai;
}

export function createFakeLinkedIn({ clock, random, start }: { clock: Clock; random: RandomSource; start: Date }): FakeLinkedIn {
  const world = new FakeWorld({ start: new Date(start.getTime() - 60 * DAY_MS), userName: "Demo User" });
  const specs = Array.from({ length: MEMBERS }, (_, i) => member(i + 1));
  for (const spec of specs) world.addMember(spec);
  const ids = specs.map((spec) => spec.publicId);
  world.setRecommendations([
    { title: "People you may know from Milano", publicIds: ids.slice(0, 14) },
    { title: "People in the construction industry you may know", publicIds: ids.slice(14, 26) },
  ]);
  world.setSearchResults(DEMO_SEARCH_URL, ids.slice(20, 36));
  return {
    world,
    driver: () => world.connect({ clock, random }).driver,
    outreach: true,
    ai: createFakeAi,
  };
}
