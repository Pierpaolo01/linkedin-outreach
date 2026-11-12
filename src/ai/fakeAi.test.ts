import { describe, expect, it } from "vitest";
import { createFakeAi } from "./fakeAi";
import type { ProfileForScoring } from "./types";

const BRIEF = "Owners of construction firms around Bergamo";
const ai = createFakeAi();

describe("fakeAi", () => {
  it("scores 3 points per brief keyword found on the card, capped at 10", async () => {
    const answer = await ai.scoreCards(BRIEF, [
      { publicId: "a", fullName: "Anna Verdi", headline: "Construction site manager", location: "Bergamo", company: null },
      { publicId: "b", fullName: "Luca Neri", headline: "Software engineer", location: "Milano", company: "Acme" },
    ]);

    expect(answer.model).toBe("fake");
    expect(answer.value).toEqual([
      { publicId: "a", score: 6, reason: "Matches the brief on: construction, bergamo.", openProfile: true },
      { publicId: "b", score: 0, reason: "Nothing on the card matches the brief.", openProfile: false },
    ]);
  });

  it("scores a profile the same way over all its text", async () => {
    const profile: ProfileForScoring = {
      publicId: "a",
      fullName: "Anna Verdi",
      headline: null,
      location: "Bergamo",
      about: "Owners of a small construction business.",
      currentTitle: null,
      currentCompany: null,
      experience: [{ title: "Founder", company: "Verdi Firms", dateRange: null, description: null }],
    };
    const answer = await ai.scoreProfile(BRIEF, profile);
    expect(answer.value).toEqual({
      score: 10,
      reason: "Matches the brief on: owners, construction, firms, bergamo.",
      industry: null,
      size: null,
    });
  });

  it("cleans names and companies by rule", async () => {
    expect((await ai.cleanVariables({ fullName: "Dott. Marco Rossi 🚀 | Growth", company: "ROSSI COSTRUZIONI S.R.L." })).value).toEqual({
      firstName: "Marco",
      companyShort: "Rossi Costruzioni",
    });
    expect((await ai.cleanVariables({ fullName: "Ing. GIULIA bianchi", company: "Bianchi Impianti srl" })).value).toEqual({
      firstName: "Giulia",
      companyShort: "Bianchi Impianti",
    });
    expect((await ai.cleanVariables({ fullName: "🚀 | ", company: null })).value).toEqual({ firstName: null, companyShort: null });
  });

  it("personalises from the first sentence of the about text, or not at all", async () => {
    const profile: ProfileForScoring = {
      publicId: "a",
      fullName: "Anna Verdi",
      headline: null,
      location: null,
      about: "We renovate old farmhouses in the Bergamo valleys. Call us.",
      currentTitle: null,
      currentCompany: null,
      experience: [],
    };
    expect((await ai.personalise({ profile, industry: null, instructions: "" })).value).toEqual({
      line: 'Your profile says: "We renovate old farmhouses in the Bergamo valleys."',
      evidence: "We renovate old farmhouses in the Bergamo valleys.",
    });
    expect((await ai.personalise({ profile: { ...profile, about: null }, industry: null, instructions: "" })).value).toBeNull();
  });
});
