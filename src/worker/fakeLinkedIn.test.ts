import { describe, expect, it } from "vitest";
import { createKit, START } from "../engine/testKit";
import { DEMO_SEARCH_URL, createFakeLinkedIn } from "./fakeLinkedIn";

describe("the fake LinkedIn of LINKEDIN_DRIVER=fake", () => {
  it("has a few dozen invented members behind recommendations and one search", async () => {
    const kit = createKit();
    try {
      const fake = createFakeLinkedIn({ clock: kit.clock, random: kit.random, start: START });
      const driver = fake.driver();

      const recommendations = await driver.listRecommendations();
      const search = await driver.searchPeople({ url: DEMO_SEARCH_URL });

      const recommended = recommendations.groups.flatMap((group) => group.cards);
      expect(recommended.length).toBeGreaterThanOrEqual(20);
      expect(search.cards.length).toBeGreaterThan(0);
      expect(fake.outreach).toBe(true);
      expect((await fake.ai().scoreCards("construction company owner", search.cards)).value).toHaveLength(search.cards.length);
    } finally {
      kit.close();
    }
  });
});
