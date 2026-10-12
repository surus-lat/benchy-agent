// Regenerates apps/web/public/brand/platform-author-research{,-es}.png from the
// HTML embeds in ./embeds — the window at its authored 1440px width (scale 1,
// no reflow), 2x, transparent outside the rounded window, pip in its static
// reduced-motion state so the capture is deterministic.
//
// Needs Chrome and puppeteer-core (not a repo dependency):
//   npm i --no-save puppeteer-core
//   node docs/design/platform-view-handoff/export-window.mjs \
//     docs/design/platform-view-handoff/embeds/research-author-es.html \
//     apps/web/public/brand/platform-author-research-es.png
//   (EN: research-author-en.html → platform-author-research.png)

import puppeteer from "puppeteer-core";
const [file, out] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();
// body has 48px padding: 1536 viewport → .ba-fit is exactly 1440 → scale 1.
await page.setViewport({ width: 1536, height: 1400, deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await page.goto("file://" + (file.startsWith("/") ? file : process.cwd() + "/" + file), { waitUntil: "networkidle0", timeout: 60000 });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => { document.body.style.background = "transparent"; document.body.style.backgroundImage = "none"; });
await new Promise((r) => setTimeout(r, 600));
const win = await page.$('[data-export="app-window"]');
const box = await win.boundingBox();
const scale = await page.evaluate(() => getComputedStyle(document.querySelector(".ba-fit")).getPropertyValue("--ba-fit").trim());
await win.screenshot({ path: out, omitBackground: true });
console.log(JSON.stringify({ out, cssWidth: Math.round(box.width), cssHeight: Math.round(box.height), ratio: +(box.width / box.height).toFixed(3), scale: scale || "1" }));
await browser.close();
