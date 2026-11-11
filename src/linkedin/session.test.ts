import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPage, ensureSession, type SessionState } from "./session";

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/session/${name}`, import.meta.url), "utf8");
}

const blank = "<!DOCTYPE html><html lang=\"en\"><head></head><body></body></html>";

describe("classifyPage", () => {
  describe("logged out", () => {
    it.each([
      "https://www.linkedin.com/login",
      "https://www.linkedin.com/login/it",
      "https://www.linkedin.com/uas/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F",
      "https://www.linkedin.com/authwall?trk=gf&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F",
      "https://www.linkedin.com/signup/cold-join",
    ])("on the login wall at %s", (url) => {
      const result = classifyPage({ url, html: blank });
      expect(result.state).toBe("logged_out");
      expect(result.evidence).toContain("url path");
    });

    it("on the real login page, which embeds an invisible reCAPTCHA widget", () => {
      // Seen live 2026-11-11: /login carries a g-recaptcha element and is not a challenge.
      const html =
        '<html lang="en"><body><form><input name="session_key"><input name="session_password">' +
        '<div class="g-recaptcha" data-size="invisible"></div></form></body></html>';
      expect(classifyPage({ url: "https://www.linkedin.com/login", html }).state).toBe("logged_out");
    });

    it.each(["https://www.linkedin.com/", "https://it.linkedin.com/"])(
      "on the logged-out home page %s",
      (url) => {
        expect(classifyPage({ url, html: blank }).state).toBe("logged_out");
      },
    );

    it("when a login form is on the page, whatever the URL", () => {
      const html = '<html lang="it"><body><form><input name="session_key" type="text"></form></body></html>';
      const result = classifyPage({ url: "https://www.linkedin.com/in/someone/", html });
      expect(result.state).toBe("logged_out");
      expect(result.evidence).toContain('[name="session_key"]');
    });
  });

  describe("checkpoint", () => {
    it("on any URL under /checkpoint/", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/checkpoint/challenge/AgFakeChallengeId?ut=fake",
        html: fixture("synthetic-checkpoint-challenge-en.html"),
      });
      expect(result).toEqual({ state: "checkpoint", evidence: "url path /checkpoint/challenge/AgFakeChallengeId" });
    });

    it("on a CAPTCHA widget outside /checkpoint/ (Italian)", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/uas/consumer-captcha-v2?challengeId=fake",
        html: fixture("synthetic-captcha-security-check-it.html"),
      });
      expect(result.state).toBe("checkpoint");
    });

    it("on a CAPTCHA widget with no recognised wording", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/uas/consumer-captcha-v2?challengeId=fake",
        html: '<html lang="en"><body><iframe src="https://client-api.arkoselabs.com/fc/"></iframe></body></html>',
      });
      expect(result.state).toBe("checkpoint");
      expect(result.evidence).toContain("arkoselabs");
    });

    it.each([
      ["en", "<h1>Let’s do a quick   security check</h1>"],
      ["it", "<h1>Facciamo un rapido controllo di sicurezza</h1>"],
    ])("on the security-check wording alone (%s)", (language, body) => {
      const result = classifyPage({
        url: "https://www.linkedin.com/feed/",
        html: `<html lang="${language}"><body>${body}</body></html>`,
      });
      expect(result.state).toBe("checkpoint");
      expect(result.evidence).toContain(`(${language})`);
    });
  });

  describe("restricted", () => {
    it("on the English notice, even with the signed-in navigation", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/feed/",
        html: fixture("synthetic-restricted-en.html"),
      });
      expect(result).toEqual({
        state: "restricted",
        evidence: 'text "your account has been temporarily restricted" (en)',
      });
    });

    it("on the Italian notice, ahead of the /checkpoint/ URL", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/checkpoint/restriction/fake",
        html: fixture("synthetic-restricted-it.html"),
      });
      expect(result).toEqual({
        state: "restricted",
        evidence: 'text "il tuo account è stato temporaneamente limitato" (it)',
      });
    });

    it("whatever language the page declares", () => {
      const html = '<html lang="en"><body><p>Abbiamo limitato il tuo account</p></body></html>';
      expect(classifyPage({ url: "https://www.linkedin.com/feed/", html }).state).toBe("restricted");
    });
  });

  describe("ok", () => {
    it("on the feed with the signed-in navigation", () => {
      const result = classifyPage({
        url: "https://www.linkedin.com/feed/",
        html: fixture("synthetic-feed-signed-in.html"),
      });
      expect(result).toEqual({ state: "ok", evidence: 'marker [id="global-nav"]' });
    });

    it("ignores wording hidden in scripts and embedded data", () => {
      // The fixture embeds restriction and CAPTCHA strings inside <script> and <code>.
      const html = fixture("synthetic-feed-signed-in.html");
      expect(html).toContain("Your account has been restricted");
      expect(classifyPage({ url: "https://www.linkedin.com/feed/", html }).state).toBe("ok");
    });

    it("on any other signed-in page, so every driver function can check health", () => {
      const html = '<html><body><header id="global-nav"></header><main>Profile</main></body></html>';
      expect(classifyPage({ url: "https://www.linkedin.com/in/someone/", html }).state).toBe("ok");
    });
  });

  describe("unknown", () => {
    it.each<[string, string]>([
      ["https://www.linkedin.com/feed/", blank],
      ["https://www.linkedin.com/in/someone/", "<html><body><main>Something new</main></body></html>"],
      ["about:blank", blank],
      ["chrome-error://chromewebdata/", blank],
      ["https://www.example.com/login", blank],
      ["https://evil-linkedin.com/feed/", '<header id="global-nav"></header>'],
      ["not a url", blank],
    ])("on %s with nothing recognisable", (url, html) => {
      const result = classifyPage({ url, html });
      expect(result.state satisfies SessionState).toBe("unknown");
      expect(result.evidence).not.toBe("");
    });
  });
});

describe("ensureSession", () => {
  it("opens the feed, waits for it to settle and returns the state without throwing", async () => {
    const visited: string[] = [];
    let url = "about:blank";
    const page = {
      goto: async (target: string) => {
        visited.push(target);
        url = "https://www.linkedin.com/authwall?trk=gf";
        return null;
      },
      waitForLoadState: async () => undefined,
      waitForSelector: async () => null,
      url: () => url,
      content: async () => blank,
    };

    const result = await ensureSession(page);

    expect(visited).toEqual(["https://www.linkedin.com/feed/"]);
    expect(result.state).toBe("logged_out");
  });

  it("still classifies when the page never settles", async () => {
    const page = {
      goto: async () => null,
      waitForLoadState: async () => {
        throw new Error("Timeout 15000ms exceeded");
      },
      waitForSelector: async () => {
        throw new Error("Timeout 10000ms exceeded");
      },
      url: () => "https://www.linkedin.com/feed/",
      content: async () => fixture("synthetic-feed-signed-in.html"),
    };

    expect((await ensureSession(page)).state).toBe("ok");
  });
});
