import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { scrubHtml } from "./scrub";

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

describe("scrubHtml: structure", () => {
  it("empties script, style, noscript, template and iframe elements and drops comments", () => {
    const html =
      "<html><head><script>var me = 'Jane';</script><style>.a{color:red}</style></head>" +
      "<body><!-- jane@x.com --><noscript><img src=x></noscript><template><p>hi</p></template>" +
      '<iframe src="/x"><p>inside</p></iframe><p>kept</p></body></html>';

    expect(scrubHtml(html, {})).toBe(
      "<html><head><script></script><style></style></head>" +
        '<body><noscript></noscript><template></template><iframe src="/x"></iframe><p>kept</p></body></html>',
    );
  });

  it("keeps a comment-like string inside a script from eating the markup after it", () => {
    expect(scrubHtml("<script>if (a <!-- b) {}</script><p>kept</p>", {})).toBe("<script></script><p>kept</p>");
  });

  it("drops code elements holding JSON, raw, entity-encoded or inside a comment, and keeps other code", () => {
    const html =
      '<code id="a">{"name":"Jane"}</code><code style="display: none">{&quot;x&quot;:1}</code>' +
      '<code id="c"><!--[{"y":2}]--></code><code>npm test</code>';

    expect(scrubHtml(html, {})).toBe("<code>npm test</code>");
  });

  it("drops link tags and meta tags other than charset", () => {
    const html =
      '<head><meta charset="utf-8"><meta name="description" content="Jane Doe"><link rel="preload" href="https://static.licdn.com/a.css">' +
      '<meta property="og:image" content="https://media.licdn.com/p.jpg"/></head>';

    expect(scrubHtml(html, {})).toBe('<head><meta charset="utf-8"></head>');
  });

  it("replaces every image src with a 1x1 pixel and removes srcset", () => {
    const html = '<img class="photo" src="https://media.licdn.com/dms/image/abc" srcset="a 1x, b 2x" alt="">';

    expect(scrubHtml(html, {})).toBe(`<img class="photo" src="${PIXEL}" alt="">`);
  });

  it("removes inline background images but keeps the rest of the style", () => {
    const html = `<div style="color: red; background-image: url(&quot;https://media.licdn.com/x.jpg&quot;)"></div><div style="background:url('/a.png')"></div>`;

    expect(scrubHtml(html, {})).toBe('<div style="color: red"></div><div></div>');
  });

  it("removes data attributes holding a URL or a urn, and keeps the others", () => {
    const html =
      '<div data-testid="card" data-delayed-url="https://media.licdn.com/x" data-entity-urn="urn:li:fsd_profile:ACoAAB1" data-view-name="search-result"></div>';

    expect(scrubHtml(html, {})).toBe('<div data-testid="card" data-view-name="search-result"></div>');
  });

  it("points links and sources at LinkedIn CDNs or other hosts to about:blank and leaves LinkedIn links", () => {
    const html =
      '<a href="https://example.com/me">site</a><a href="//static.licdn.com/sc/h/x">x</a>' +
      '<form action="https://evil.test/post"></form><script src="https://static.licdn.com/app.js"></script>' +
      '<a href="https://www.linkedin.com/feed/">Home</a><a href="/mynetwork/">My Network</a><a href="#top">top</a>';

    expect(scrubHtml(html, {})).toBe(
      '<a href="about:blank">site</a><a href="about:blank">x</a>' +
        '<form action="about:blank"></form><script src="about:blank"></script>' +
        '<a href="https://www.linkedin.com/feed/">Home</a><a href="/mynetwork/">My Network</a><a href="#top">top</a>',
    );
  });

  it("leaves no licdn URL anywhere, even in text and other attributes", () => {
    const out = scrubHtml('<div aria-label="see https://media.licdn.com/dms/x?e=1">https://media.licdn.com/y</div>', {});

    expect(out).not.toContain("licdn");
  });
});

describe("scrubHtml: profile, company and school links", () => {
  it("numbers profile ids by first appearance, the same id always getting the same number", () => {
    const html =
      '<a href="https://www.linkedin.com/in/jane-doe-123/">a</a><a href="/in/john-roe">b</a>' +
      '<a href="/in/Jane-Doe-123/">c</a><a href="/in/j%C3%A9r%C3%B4me/">d</a>';

    expect(scrubHtml(html, {})).toBe(
      '<a href="https://www.linkedin.com/in/person-1/">a</a><a href="/in/person-2">b</a>' +
        '<a href="/in/person-1/">c</a><a href="/in/person-3/">d</a>',
    );
  });

  it("drops query strings and fragments, keeps the rest of the path", () => {
    const html =
      '<a href="/in/jane/?miniProfileUrn=urn%3Ali%3Afsd_profile%3AACoAAB&amp;lipi=x#top">a</a>' +
      '<a href="/in/jane/overlay/contact-info/">b</a><a href="/in/jane/details/interests/?initialTabId=1">c</a>';

    expect(scrubHtml(html, {})).toBe(
      '<a href="/in/person-1/">a</a><a href="/in/person-1/overlay/contact-info/">b</a><a href="/in/person-1/details/interests/">c</a>',
    );
  });

  it("replaces profile ids in any attribute, in text and URL-encoded inside other URLs", () => {
    const html =
      '<div aria-label="Open /in/jane/" title="linkedin.com/in/john"><p>linkedin.com/in/jane</p>' +
      '<a href="/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjohn%2F">x</a></div>';

    expect(scrubHtml(html, {})).toBe(
      '<div aria-label="Open /in/person-1/" title="linkedin.com/in/person-2"><p>linkedin.com/in/person-1</p>' +
        '<a href="/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fperson-2%2F">x</a></div>',
    );
  });

  it("numbers company and school slugs separately from people", () => {
    const html =
      '<a href="/company/acme/">a</a><a href="https://www.linkedin.com/company/12345/life/">b</a>' +
      '<a href="/school/uni-of-x/">c</a><a href="/company/acme/?trk=1">d</a><a href="/in/jane/">e</a>';

    expect(scrubHtml(html, {})).toBe(
      '<a href="/company/company-1/">a</a><a href="https://www.linkedin.com/company/company-2/life/">b</a>' +
        '<a href="/school/school-1/">c</a><a href="/company/company-1/">d</a><a href="/in/person-1/">e</a>',
    );
  });
});

describe("scrubHtml: known strings", () => {
  it("replaces names, companies and schools with numbered stand-ins in text and attribute values", () => {
    const html =
      '<img alt="Jane Doe" src="x"><a aria-label="View Jane Doe’s profile">Jane Doe</a>' +
      "<p>John Roe</p><p>Acme Corp</p><p>University of Somewhere</p>";

    expect(
      scrubHtml(html, { names: ["Jane Doe", "John Roe"], companies: ["Acme Corp", "University of Somewhere"] }),
    ).toBe(
      `<img alt="Person 1" src="${PIXEL}"><a aria-label="View Person 1’s profile">Person 1</a>` +
        "<p>Person 2</p><p>Company 1</p><p>Company 2</p>",
    );
  });

  it("replaces longer strings first so a name inside a headline does not break it", () => {
    const html = "<p>Ann Lee</p><p>Ann Lee Smith</p><p>Partner at Lee &amp; Ann Lee Consulting</p>";

    const out = scrubHtml(html, {
      names: ["Ann Lee", "Ann Lee Smith"],
      texts: ["Partner at Lee & Ann Lee Consulting"],
    });

    expect(out).toMatch(/^<p>Person 1<\/p><p>Person 2<\/p><p>lorem [a-z ]+<\/p>$/);
  });

  it("matches entity-encoded and curly or straight apostrophe forms", () => {
    const html =
      "<p>Seán O&#39;Brien</p><p>Seán O’Brien</p><p>Seán O&#x27;Brien</p><p>Seán O&apos;Brien</p>" +
      '<p title="Smith &amp; Sons">Smith &amp; Sons</p><p>Smith&nbsp;&amp; Sons</p>';

    expect(scrubHtml(html, { names: ["Seán O'Brien"], companies: ["Smith & Sons"] })).toBe(
      "<p>Person 1</p><p>Person 1</p><p>Person 1</p><p>Person 1</p>" +
        '<p title="Company 1">Company 1</p><p>Company 1</p>',
    );
  });

  it("replaces texts with lorem filler of the same length", () => {
    const headline = "Founder at a small studio | Building things for people";

    const out = scrubHtml(`<div class="headline">${headline}</div>`, { texts: [headline] });

    const filler = /^<div class="headline">([^<]*)<\/div>$/.exec(out)?.[1] ?? "";
    expect(filler).toHaveLength(headline.length);
    expect(filler).toMatch(/^lorem ipsum( [a-z]+)*$/);
  });

  it("replaces first and last names standing alone, but not tokens shorter than 3 letters or inside other words", () => {
    const html =
      '<button aria-label="Message Jane">Message</button><p>Jane’s post</p><p>Janet and Doering</p>' +
      "<p>Thanks, Doe!</p><p>Al Bo</p><p>Also Bold</p>";

    expect(scrubHtml(html, { names: ["Jane Doe", "Al Bo"] })).toBe(
      '<button aria-label="Message Person 1">Message</button><p>Person 1’s post</p><p>Janet and Doering</p>' +
        "<p>Thanks, Person 1!</p><p>Person 2</p><p>Also Bold</p>",
    );
  });

  it("leaves class names, data-testid and role values alone", () => {
    const html = '<div class="Jane" data-testid="Jane" role="Jane" title="Jane"></div>';

    expect(scrubHtml(html, { names: ["Jane Doe"] })).toBe(
      '<div class="Jane" data-testid="Jane" role="Jane" title="Person 1"></div>',
    );
  });
});

describe("scrubHtml: leftovers", () => {
  it("replaces email addresses", () => {
    expect(scrubHtml('<a href="mailto:jane.doe+x@mail.example.co.uk">jane.doe+x@mail.example.co.uk</a>', {})).toBe(
      '<a href="mailto:person@example.com">person@example.com</a>',
    );
  });

  it("zeroes phone-number-like runs of 9 or more digits and leaves shorter numbers", () => {
    expect(scrubHtml("<p>+39 333 123 4567, 3331234567, 12345678, 2nd, 500+ connections</p>", {})).toBe(
      "<p>+00 000 000 0000, 0000000000, 12345678, 2nd, 500+ connections</p>",
    );
  });

  it("numbers urn values per call, raw, compound and URL-encoded, the same value getting the same number", () => {
    const html =
      '<div componentkey="urn:li:member:123456789"></div><div componentkey="urn:li:member:987654321"></div>' +
      '<a href="/in/jane/details/skills/urn:li:fsd_skill:(ACoAAB-x_y,42)/">s</a>' +
      '<a href="/feed/?u=urn%3Ali%3Amember%3A123456789">f</a><p>urn:li:member:987654321</p>';

    expect(scrubHtml(html, {})).toBe(
      '<div componentkey="urn:li:member:ID1"></div><div componentkey="urn:li:member:ID2"></div>' +
        '<a href="/in/person-1/details/skills/urn:li:fsd_skill:ID3/">s</a>' +
        '<a href="/feed/?u=urn%3Ali%3Amember%3AID1">f</a><p>urn:li:member:ID2</p>',
    );
  });

  it("keeps the suffix LinkedIn appends to numeric urns in component keys", () => {
    const once = scrubHtml('<div componentkey="urn:li:member:123456789_connect"></div>', {});

    expect(once).toBe('<div componentkey="urn:li:member:ID1_connect"></div>');
    expect(scrubHtml(once, {})).toBe(once);
  });

  it("replaces long opaque tokens in attribute values only", () => {
    const token = "AQEDAR0g4kQB5x7xAAABmZ3mN7oAAAGZvf3qT1YAqJhG8KQ";
    const hex = "0123456789abcdef0123456789abcdef01234567";
    const html =
      `<a href="/messaging/thread/2-${token}==/" data-token="${hex}" class="artdeco-entity-lockup__subtitle-very-long-name-x">${token}</a>`;

    expect(scrubHtml(html, {})).toBe(
      `<a href="/messaging/thread/TOKEN/" data-token="TOKEN" class="artdeco-entity-lockup__subtitle-very-long-name-x">${token}</a>`,
    );
  });
});

describe("scrubHtml: invariants", () => {
  it("keeps elements, class names, data-testid, role, aria attribute names and interface wording", () => {
    const html =
      '<ul role="list"><li class="card entity" data-testid="lockup"><a href="/in/jane-doe-123/" aria-label="View Jane Doe’s profile">Jane Doe</a>' +
      '<span class="degree">2nd</span><button aria-label="Invite Jane Doe to connect" class="artdeco-button">Connect</button>' +
      '<button aria-label="Message Jane">Message</button><span>Pending</span></li></ul>';

    const out = scrubHtml(html, { names: ["Jane Doe"] });
    const before = parse(html);
    const after = parse(out);

    expect(after.querySelectorAll("*").map((el) => el.tagName)).toEqual(before.querySelectorAll("*").map((el) => el.tagName));
    expect(after.querySelectorAll("*").map((el) => Object.keys(el.attributes))).toEqual(
      before.querySelectorAll("*").map((el) => Object.keys(el.attributes)),
    );
    expect(after.querySelector("li")?.getAttribute("class")).toBe("card entity");
    expect(after.querySelector("li")?.getAttribute("data-testid")).toBe("lockup");
    expect(after.querySelectorAll("button").map((b) => b.text)).toEqual(["Connect", "Message"]);
    expect(after.querySelector(".degree")?.text).toBe("2nd");
    expect(out).toContain("<span>Pending</span>");
    expect(out).not.toMatch(/Jane|Doe/);
  });

  it("is deterministic and idempotent", () => {
    const html =
      '<a href="https://www.linkedin.com/in/jane-doe/?miniProfileUrn=urn%3Ali%3Afsd_profile%3AACoAAB">Jane Doe</a>' +
      '<div componentkey="urn:li:member:123456789" data-x="https://example.com"></div><p>Call +39 333 123 4567 or jane@doe.it</p>' +
      '<img src="https://media.licdn.com/x"><a href="/company/acme/">Acme</a><span>Great headline here</span>';
    const sensitive = { names: ["Jane Doe"], companies: ["Acme"], texts: ["Great headline here"] };

    const once = scrubHtml(html, sensitive);

    expect(scrubHtml(html, sensitive)).toBe(once);
    expect(scrubHtml(once, sensitive)).toBe(once);
    expect(scrubHtml(once, {})).toBe(once);
  });
});
