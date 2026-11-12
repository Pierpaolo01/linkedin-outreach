// PROTOTYPE screenshot script. Needs the prototype served first (see vite.config.ts).
// node prototypes/dashboard-layouts/shoot.mjs <baseUrl> <outDir> [extraDir]
// Writes the 12 gate-3 PNGs to outDir; with extraDir, also phone Home shots for review.
import { chromium } from "playwright";
import { join } from "node:path";

const [base = "http://127.0.0.1:5179", outDir = "docs/milestones/img", extraDir] = process.argv.slice(2);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const shots = [];
for (const v of ["a", "b", "c"]) {
  shots.push({ file: `m3-layout-${v}-home.png`, v, screen: "home", stop: false, size: DESKTOP });
  shots.push({ file: `m3-layout-${v}-home-stop.png`, v, screen: "home", stop: true, size: DESKTOP });
  shots.push({ file: `m3-layout-${v}-approvals.png`, v, screen: "approvals", stop: false, size: DESKTOP });
  shots.push({ file: `m3-layout-${v}-approvals-phone.png`, v, screen: "approvals", stop: false, size: PHONE });
  if (extraDir) {
    shots.push({ file: `phone-${v}-home.png`, v, screen: "home", stop: false, size: PHONE, extra: true });
    shots.push({ file: `phone-${v}-home-stop.png`, v, screen: "home", stop: true, size: PHONE, extra: true });
  }
}

const browser = await chromium.launch({ channel: "chrome" });
const problems = [];
try {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: s.size, deviceScaleFactor: s.size === PHONE ? 2 : 1 });
    const url = `${base}/?v=${s.v}&screen=${s.screen}${s.stop ? "&stop=1" : ""}&clean=1`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) problems.push(`${s.file}: horizontal overflow ${overflow}px`);
    // Grow the viewport to the page height instead of fullPage, so sticky and fixed bars
    // (sidebar, dock, action bars) sit where they would at the end of a scroll, not mid-page.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > s.size.height) await page.setViewportSize({ width: s.size.width, height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(s.extra ? extraDir : outDir, s.file) });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(problems.length === 0 ? `ok: ${shots.length} screenshots, no horizontal overflow` : problems.join("\n"));
process.exitCode = problems.length === 0 ? 0 : 1;
