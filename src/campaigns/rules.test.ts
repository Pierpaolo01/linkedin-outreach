import { describe, expect, it } from "vitest";
import { createLiveDriver, type DriverPage } from "../linkedin/driver";
import {
  campaignFieldsSchema,
  moveRefusal,
  fieldProblems,
  isPeopleSearchUrl,
  liveEditRefusal,
  previewTexts,
  startProblems,
  type CampaignFields,
} from "./rules";

const ready: CampaignFields = {
  targetProspectCount: 100,
  batchSize: 25,
  autoApprove: false,
  scoreThreshold: 7,
  openProfileThreshold: 6,
  aiPersonalise: false,
  personalisationInstructions: null,
  acceptToMessageMinHours: 24,
  acceptToMessageMaxHours: 48,
  followUpDelayMinHours: 24,
  followUpDelayMaxHours: 48,
  delayPolicy: "calendar",
  withdrawAfterDays: 21,
  name: "Test campaign",
  discoverySource: "search",
  sourceUrls: ["https://www.linkedin.com/search/results/people/?keywords=founder"],
  scoringBrief: "Founders of small manufacturing companies in Italy",
  inviteNote: "Hi {{first_name}}, I work with companies like {{company}}.",
  firstMessage: "Thanks for connecting, {{first_name}}.",
  followUp: "",
};

/** Addresses a user might paste as a search source. */
const SEARCH_URLS = {
  good: [
    "https://www.linkedin.com/search/results/people/",
    "https://www.linkedin.com/search/results/people/?keywords=founder",
    "https://www.linkedin.com/search/results/people/?geoUrn=%5B%22103350119%22%5D&origin=FACETED_SEARCH",
    "https://WWW.LinkedIn.com/search/results/people/?keywords=cfo",
    "https://www.linkedin.com:443/search/results/people/?keywords=cfo",
    // The driver checks only that the path starts with the people-search path.
    "https://www.linkedin.com/search/results/people/more/",
  ],
  bad: [
    "https://linkedin.com/search/results/people/?keywords=founder",
    "https://it.linkedin.com/search/results/people/",
    "https://www.linkedin.com/search/results/people?keywords=founder",
    "https://www.linkedin.com/search/results/companies/?keywords=x",
    "https://www.linkedin.com/in/test-person-1/",
    "http://www.linkedin.com/search/results/people/",
    "https://evil.example/search/results/people/",
    "https://linkedin.com.evil.example/search/results/people/",
    "https://www.linkedin.com.evil.example/search/results/people/",
    "www.linkedin.com/search/results/people/",
    "not a url",
    "",
  ],
};

/** Whether the live driver's `searchPeople` takes the address. Its page fails any load, so nothing is ever opened. */
async function driverTakes(url: string): Promise<boolean> {
  const loaded = new Error("loaded");
  const page: DriverPage = {
    load: async () => {
      throw loaded;
    },
    url: () => "about:blank",
    content: async () => "",
    screenshot: async () => Buffer.from(""),
  };
  const driver = createLiveDriver({ page, pace: async () => undefined });
  try {
    await driver.searchPeople({ url });
  } catch (error) {
    if (error === loaded) return true;
    if (error instanceof RangeError) return false;
    throw error;
  }
  throw new Error("the fake page cannot load anything");
}

describe("isPeopleSearchUrl", () => {
  it.each(SEARCH_URLS.good)("accepts %s", (url) => {
    expect(isPeopleSearchUrl(url)).toBe(true);
  });

  it.each(SEARCH_URLS.bad)("refuses %s", (url) => {
    expect(isPeopleSearchUrl(url)).toBe(false);
  });

  it.each([...SEARCH_URLS.good, ...SEARCH_URLS.bad])("agrees with the driver's searchPeople on %s", async (url) => {
    expect(isPeopleSearchUrl(url)).toBe(await driverTakes(url));
  });
});

describe("startProblems", () => {
  it("finds nothing wrong with a complete campaign", () => {
    expect(startProblems(ready, { confirmAutoApprove: false })).toEqual({});
  });

  it("needs a name", () => {
    expect(startProblems({ ...ready, name: "  " }, { confirmAutoApprove: false })).toEqual({
      name: "Give the campaign a name",
    });
  });

  it("needs at least one search URL for a people-search campaign", () => {
    expect(startProblems({ ...ready, sourceUrls: [] }, { confirmAutoApprove: false })).toEqual({
      sourceUrls: "Add at least one LinkedIn people-search URL",
    });
  });

  it("names each search URL that is not a LinkedIn people search", () => {
    const problems = startProblems(
      { ...ready, sourceUrls: [ready.sourceUrls[0] ?? "", "https://www.linkedin.com/in/test-person-1/"] },
      { confirmAutoApprove: false },
    );
    expect(problems).toEqual({
      "sourceUrls.1": "This is not a LinkedIn people search. Copy the address of a search on www.linkedin.com/search/results/people/",
    });
  });

  it("needs no URL for a recommendations campaign", () => {
    expect(startProblems({ ...ready, discoverySource: "recommendations", sourceUrls: [] }, { confirmAutoApprove: false })).toEqual({});
  });

  it("needs a scoring brief", () => {
    expect(startProblems({ ...ready, scoringBrief: "" }, { confirmAutoApprove: false })).toEqual({
      scoringBrief: "Describe who fits this campaign and who does not",
    });
  });

  it("needs a first message", () => {
    expect(startProblems({ ...ready, firstMessage: " " }, { confirmAutoApprove: false })).toEqual({
      firstMessage: "Write the first message",
    });
  });

  it("refuses an unknown variable in any template", () => {
    const problems = startProblems(
      { ...ready, firstMessage: "Hi {{firstname}}", followUp: "Any news, {{nome}}?" },
      { confirmAutoApprove: false },
    );
    expect(problems).toEqual({
      firstMessage:
        "{{firstname}} is not a variable. Use {{first_name}}, {{company}}, {{title}}, {{location}}, {{industry}} or {{ai_line}}",
      followUp: "{{nome}} is not a variable. Use {{first_name}}, {{company}}, {{title}}, {{location}}, {{industry}} or {{ai_line}}",
    });
  });

  it("refuses broken braces", () => {
    expect(startProblems({ ...ready, firstMessage: "Hi {{first_name}" }, { confirmAutoApprove: false })).toEqual({
      firstMessage: "The braces do not match. Write variables as {{first_name}}",
    });
  });

  it("refuses {{ai_line}} while personalisation is off", () => {
    expect(startProblems({ ...ready, firstMessage: "Hi. {{ai_line}}", aiPersonalise: false }, { confirmAutoApprove: false })).toEqual({
      firstMessage: "{{ai_line}} is written by the AI only when personalisation is on. Turn it on or remove {{ai_line}}",
    });
    expect(startProblems({ ...ready, firstMessage: "Hi. {{ai_line}}", aiPersonalise: true }, { confirmAutoApprove: false })).toEqual({});
  });

  it("refuses an invite note longer than 300 characters once filled with long sample values", () => {
    // 250 characters of text plus {{company}}: fine with a short company, too long with a long one.
    const note = `${"x".repeat(250)} {{company}}`;
    const problems = startProblems({ ...ready, inviteNote: note }, { confirmAutoApprove: false });
    expect(problems.inviteNote).toMatch(/^The invite note must be at most 300 characters with the variables filled in\. With long sample values it comes to \d+\.$/);
  });

  it("accepts no invite note", () => {
    expect(startProblems({ ...ready, inviteNote: null }, { confirmAutoApprove: false })).toEqual({});
    expect(startProblems({ ...ready, inviteNote: "" }, { confirmAutoApprove: false })).toEqual({});
  });

  it("keeps the open-profile threshold at or below the score threshold", () => {
    expect(startProblems({ ...ready, scoreThreshold: 5, openProfileThreshold: 6 }, { confirmAutoApprove: false })).toEqual({
      openProfileThreshold: "The open-profile threshold must not be above the score threshold (5)",
    });
  });

  it("keeps each minimum delay at or below its maximum", () => {
    const problems = startProblems(
      { ...ready, acceptToMessageMinHours: 50, acceptToMessageMaxHours: 48, followUpDelayMinHours: 72, followUpDelayMaxHours: 24 },
      { confirmAutoApprove: false },
    );
    expect(problems).toEqual({
      acceptToMessageMinHours: "The shortest wait must not be longer than the longest (48 hours)",
      followUpDelayMinHours: "The shortest wait must not be longer than the longest (24 hours)",
    });
  });

  it("refuses auto-approve unless confirmed", () => {
    expect(startProblems({ ...ready, autoApprove: true }, { confirmAutoApprove: false })).toEqual({
      autoApprove: "Auto-approve sends without your review. Confirm that this is what you want.",
    });
    expect(startProblems({ ...ready, autoApprove: true }, { confirmAutoApprove: true })).toEqual({});
  });
});

describe("campaignFieldsSchema", () => {
  it("accepts a partial wizard draft", () => {
    expect(campaignFieldsSchema.safeParse({ name: "Draft" }).success).toBe(true);
  });

  it("explains each wrong field", () => {
    const result = campaignFieldsSchema.safeParse({
      scoreThreshold: 11,
      openProfileThreshold: 2.5,
      discoverySource: "groups",
      batchSize: 0,
      delayPolicy: "weekdays",
      sourceUrls: "https://www.linkedin.com/search/results/people/",
      colour: "red",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldProblems(result.error)).toEqual({
      scoreThreshold: "Enter a whole number from 0 to 10",
      openProfileThreshold: "Enter a whole number from 0 to 10",
      discoverySource: "Choose recommendations or search",
      batchSize: "Enter a whole number of 1 or more",
      delayPolicy: "Choose calendar or working_days",
      sourceUrls: "Send a list of addresses",
      colour: "Unknown field",
    });
  });
});

describe("moveRefusal", () => {
  it("starts only a draft", () => {
    expect(moveRefusal("start", "draft")).toBeNull();
    expect(moveRefusal("start", "running")).toBe("Only a draft can be started; this campaign is running");
  });

  it.each(["finding", "awaiting_approval", "running"] as const)("pauses a %s campaign", (from) => {
    expect(moveRefusal("pause", from)).toBeNull();
  });

  it.each(["draft", "paused", "completed", "archived"] as const)("does not pause a %s campaign", (from) => {
    expect(moveRefusal("pause", from)).toMatch(/^Only a campaign that is finding, awaiting approval or running can be paused/);
  });

  it("resumes only a paused campaign", () => {
    expect(moveRefusal("resume", "paused")).toBeNull();
    expect(moveRefusal("resume", "running")).toBe("Only a paused campaign can be resumed; this campaign is running");
  });

  it("archives anything not archived yet", () => {
    expect(moveRefusal("archive", "running")).toBeNull();
    expect(moveRefusal("archive", "archived")).toBe("This campaign is already archived");
  });
});

describe("liveEditRefusal", () => {
  it("lets a draft change anything", () => {
    expect(liveEditRefusal("draft", { name: "New", firstMessage: "Hi" })).toBeNull();
  });

  it("lets a started campaign change only templates and timings", () => {
    expect(liveEditRefusal("running", { firstMessage: "Hi", withdrawAfterDays: 14 })).toBeNull();
    expect(liveEditRefusal("paused", { name: "New", scoringBrief: "x", firstMessage: "Hi" })).toBe(
      "Once a campaign has started only its templates and timings can change. These cannot: name, scoringBrief",
    );
  });

  it("lets nothing change once completed or archived", () => {
    expect(liveEditRefusal("archived", { firstMessage: "Hi" })).toBe("An archived campaign cannot be edited");
    expect(liveEditRefusal("completed", { firstMessage: "Hi" })).toBe("A completed campaign cannot be edited");
  });
});

describe("previewTexts", () => {
  const values = { first_name: "Test", company: "Example Srl", title: null, location: null, industry: null, ai_line: null };

  it("renders each text, or says why it cannot", () => {
    const preview = previewTexts(
      { inviteNote: "Hi {{first_name}}", firstMessage: "Hello {{first_name}} at {{title}}", followUp: "", aiPersonalise: false },
      values,
      { aiLineToCome: false },
    );
    expect(preview).toEqual({
      inviteNote: { ok: true, text: "Hi Test", length: 7 },
      firstMessage: {
        ok: false,
        problem: "unresolved_variable",
        variables: ["title"],
        message: "No value for {{title}} for this person",
      },
      followUp: null,
    });
  });

  it("reports an invite note over 300 characters for this person", () => {
    const preview = previewTexts({ inviteNote: "y".repeat(301), firstMessage: "Hi", followUp: "Again", aiPersonalise: false }, values, { aiLineToCome: false });
    expect(preview.inviteNote).toEqual({
      ok: false,
      problem: "too_long",
      variables: [],
      message: "Longer than 300 characters (301)",
    });
    expect(preview.followUp).toEqual({ ok: true, text: "Again", length: 5 });
  });

  it("shows a stand-in for the AI line when personalisation is on and none is written yet", () => {
    const preview = previewTexts({ inviteNote: null, firstMessage: "Hi. {{ai_line}}", followUp: "", aiPersonalise: true }, values, { aiLineToCome: true });
    expect(preview.firstMessage).toEqual({ ok: true, text: "Hi. [AI-written line]", length: 21 });
  });

  it("leaves a missing AI line unresolved once the AI has had its turn, as the engine would", () => {
    const preview = previewTexts({ inviteNote: null, firstMessage: "Hi. {{ai_line}}", followUp: "", aiPersonalise: true }, values, { aiLineToCome: false });
    expect(preview.firstMessage).toMatchObject({ ok: false, problem: "unresolved_variable", variables: ["ai_line"] });
  });
});
