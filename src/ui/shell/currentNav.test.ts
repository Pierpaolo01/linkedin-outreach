import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes";
import { currentNavTarget } from "./currentNav";

describe("currentNavTarget", () => {
  const listed = [1, 2, 6];

  it("names one sidebar item on every page", () => {
    expect(currentNavTarget("/", listed)).toBe("/");
    expect(currentNavTarget("/approvals", listed)).toBe("/approvals");
    expect(currentNavTarget("/review", listed)).toBe("/review");
    expect(currentNavTarget("/activity", listed)).toBe("/activity");
    expect(currentNavTarget("/stats", listed)).toBe("/stats");
    expect(currentNavTarget("/settings", listed)).toBe("/settings");
    expect(currentNavTarget("/campaigns", listed)).toBe("/campaigns");
  });

  // The wizard is within Campaigns from its first step to its last, before and after the draft has its own address.
  it("keeps Campaigns current through the whole wizard", () => {
    expect(currentNavTarget("/campaigns/new", listed)).toBe("/campaigns");
    expect(currentNavTarget("/campaigns/6/edit", listed)).toBe("/campaigns");
    expect(currentNavTarget("/campaigns/99/edit", listed)).toBe("/campaigns");
  });

  it("makes a campaign's own entry current on its page, and Campaigns when the sidebar does not list it", () => {
    expect(currentNavTarget("/campaigns/2", listed)).toBe("/campaigns/2");
    expect(currentNavTarget("/campaigns/7", listed)).toBe("/campaigns");
  });

  it("names nothing on an address with no page", () => {
    expect(currentNavTarget("/nowhere", listed)).toBeUndefined();
    expect(currentNavTarget("/campaigns/1/elsewhere", listed)).toBeUndefined();
  });

  it("covers every route", () => {
    for (const route of ROUTES) {
      const path = route.path.replace(":id", "1");
      expect(currentNavTarget(path, listed), route.path).toBeDefined();
    }
  });
});
