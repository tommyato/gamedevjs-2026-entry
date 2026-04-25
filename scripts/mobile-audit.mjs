#!/usr/bin/env node
/**
 * Mobile / touch sanity audit — captures screenshots at phone-portrait
 * (360×640) and desktop-reference (1366×768) viewports.
 *
 * Outputs to: tommyato-state/work/cc-mobile-sanity/
 * Writes:     <viewport>/{01-title, 02-leaderboard-score, 03-leaderboard-climb,
 *              04-leaderboard-combo, 05-leaderboard-daily, 06-gameplay,
 *              07-pause, 08-game-over}.png
 *
 * Also runs the IFRAME_ASSERTIONS overflow checker per screen and logs results.
 *
 * Run:  node scripts/mobile-audit.mjs
 * (Requires dist/index.html — run `npm run build` first if missing.)
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve } from "node:path";
import { once } from "node:events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const OUT_ROOT = resolve(REPO_ROOT, "../../tommyato-state/work/cc-mobile-sanity");

const FIXTURES = [
  { name: "phone-portrait", width: 360, height: 640 },
  { name: "desktop-reference", width: 1366, height: 768 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

// -------- helpers -------------------------------------------------------------

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let fsPath = join(DIST_DIR, decodeURIComponent(url.pathname));
    if (url.pathname === "/" || url.pathname === "") fsPath = join(DIST_DIR, "index.html");
    if (!fsPath.startsWith(DIST_DIR)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found: " + url.pathname);
      return;
    }
    const ext = extname(fsPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    createReadStream(fsPath).pipe(res);
  });
  server.listen(0, "127.0.0.1");
  return server;
}

// Overflow/bounds assertions (same as verify-ui.mjs)
const IFRAME_ASSERTIONS = `
(() => {
  const failures = [];
  const doc = document;
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  const annotated = Array.from(doc.querySelectorAll('[data-hud], [class^="cc-"], [class*=" cc-"]'));
  const overlayEls = [];
  for (const sel of ['#title-overlay', '#game-over-view', '#hud', '#leaderboard-modal', '#pause-overlay', '#achievements-overlay']) {
    const root = doc.querySelector(sel);
    if (!root) continue;
    const cs = getComputedStyle(root);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    overlayEls.push(root, ...Array.from(root.querySelectorAll('*')));
  }
  const seen = new Set();
  const tracked = [];
  for (const el of [...annotated, ...overlayEls]) {
    if (seen.has(el)) continue;
    seen.add(el);
    tracked.push(el);
  }
  const overflows = [];
  for (const el of tracked) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    if (el.hasAttribute('data-overlay-ok')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') continue;
    const id = el.id || (el.className && typeof el.className === 'string' ? el.className.trim().split(' ')[0] : tag);
    const overflow = [];
    if (r.left < -0.5) overflow.push('left=' + r.left.toFixed(1));
    if (r.top < -0.5) overflow.push('top=' + r.top.toFixed(1));
    if (r.right > vw + 0.5) overflow.push('right=' + r.right.toFixed(1) + '/vw=' + vw);
    if (r.bottom > vh + 0.5) overflow.push('bottom=' + r.bottom.toFixed(1) + '/vh=' + vh);
    if (overflow.length > 0) {
      overflows.push({ id: id.slice(0, 80), rect: r, overflow });
    }
  }
  failures.push(...overflows.slice(0, 12).map(o => 'overflow: ' + o.id + ' [' + o.overflow.join(', ') + ']'));
  if (overflows.length > 12) failures.push('... (' + (overflows.length - 12) + ' more overflow failures)');
  const canvas = doc.querySelector('canvas');
  if (!canvas) {
    failures.push('canvas: element missing');
  } else {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) failures.push('canvas: zero rendered size ' + r.width + 'x' + r.height);
  }
  return { vw, vh, failures, trackedCount: tracked.length };
})()
`;

async function assertScreen(page, label) {
  const result = await page.evaluate(IFRAME_ASSERTIONS);
  return {
    label,
    passed: result.failures.length === 0,
    failures: result.failures,
    trackedCount: result.trackedCount,
    vw: result.vw,
    vh: result.vh,
  };
}

async function waitForTitle(page) {
  if (page.frames) {
    // top-level page
    await page.waitForSelector("#title-overlay:not(.hidden)", { timeout: 15000 });
    await page.waitForSelector("#title-overlay h1", { state: "visible", timeout: 15000 });
  }
  await page.waitForTimeout(600);
}

// -------- screen runners ------------------------------------------------------

async function captureTitle(page, outDir, prefix) {
  await waitForTitle(page);
  const path = join(outDir, `${prefix}-title.png`);
  await page.screenshot({ path, fullPage: false });
  const r = await assertScreen(page, "title");
  r.screenshot = path;
  return r;
}

async function captureLeaderboardTab(page, outDir, prefix, tabSlug, tabLabel, index) {
  // Open the leaderboard modal
  await page.evaluate(() => {
    const btn = document.getElementById("title-btn-leaderboard");
    if (btn) btn.click();
  });
  await page.waitForSelector("#leaderboard-modal:not(.hidden)", { timeout: 5000 }).catch(() => {});
  // Click the target tab
  await page.evaluate((slug) => {
    const btn = document.querySelector(`[data-leaderboard-tab="${slug}"]`);
    if (btn) btn.click();
  }, tabSlug);
  await page.waitForTimeout(400);
  const path = join(outDir, `${index}-leaderboard-${tabLabel}.png`);
  await page.screenshot({ path, fullPage: false });
  const r = await assertScreen(page, `leaderboard-${tabLabel}`);
  r.screenshot = path;
  // Close the modal
  await page.evaluate(() => {
    const btn = document.getElementById("leaderboard-modal-close");
    if (btn) btn.click();
  });
  await page.waitForTimeout(200);
  return r;
}

async function captureGameplayAndPause(page, outDir, prefix) {
  // Start a run
  await page.evaluate(() => {
    const btn = document.getElementById("title-play-btn");
    if (btn) btn.click();
  });
  // Wait for HUD
  await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
  // Simulate a few jumps to get gameplay going
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const up = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true });
      window.dispatchEvent(up);
    });
    await page.waitForTimeout(600);
  }
  const gameplayPath = join(outDir, `${prefix}-gameplay.png`);
  await page.screenshot({ path: gameplayPath, fullPage: false });
  const gameplayR = await assertScreen(page, "gameplay");
  gameplayR.screenshot = gameplayPath;

  // Open pause
  await page.evaluate(() => {
    const btn = document.getElementById("pause-btn");
    if (btn) btn.click();
  });
  await page.waitForSelector("#pause-overlay:not(.hidden)", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const pausePath = join(outDir, `${prefix}-pause.png`);
  await page.screenshot({ path: pausePath, fullPage: false });
  const pauseR = await assertScreen(page, "pause");
  pauseR.screenshot = pausePath;

  // Close pause
  await page.evaluate(() => {
    const btn = document.getElementById("pause-btn");
    if (btn) btn.click();
  });
  await page.waitForTimeout(200);

  return [gameplayR, pauseR];
}

async function captureGameOver(page, outDir, prefix) {
  // Force game over via debug hook
  await page.evaluate(() => {
    const g = window.__ccGame;
    if (g && typeof g.debugForceGameOver === "function") {
      g.debugForceGameOver();
    }
  });
  try {
    await page.waitForSelector("#game-over-view:not(.hidden)", { timeout: 20000 });
  } catch {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const over = await page.evaluate(
        () => !document.getElementById("game-over-view")?.classList.contains("hidden"),
      );
      if (over) break;
    }
  }
  await page.waitForTimeout(600);
  const path = join(outDir, `${prefix}-gameover.png`);
  await page.screenshot({ path, fullPage: false });
  const r = await assertScreen(page, "gameover");
  r.screenshot = path;
  return r;
}

// -------- fixture runner ------------------------------------------------------

async function runFixture(browser, fixture, port, outDir) {
  const context = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    deviceScaleFactor: 1,
    isMobile: fixture.width <= 720,
    hasTouch: fixture.width <= 720,
    userAgent: fixture.width <= 720
      ? "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const results = [];
  const fixDir = join(outDir, fixture.name);
  await ensureDir(fixDir);

  const base = `http://127.0.0.1:${port}/?verify-ui=1`;
  const short = fixture.name === "phone-portrait" ? "ph" : "dt";

  // Map short fixture name to output file prefix numbers
  const pfx = {
    "phone-portrait": ["01", "02", "03", "04", "05", "06", "07", "08"],
    "desktop-reference": ["01", "02", "03", "04", "05", "06", "07", "08"],
  }[fixture.name];

  try {
    // ---- Title screen
    {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "load" });
      results.push(await captureTitle(page, fixDir, pfx[0]));
      // Also check button reachability
      const btnRects = await page.evaluate(() => {
        const ids = ["title-play-btn", "title-btn-leaderboard", "title-btn-daily", "title-btn-versus"];
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        return ids.map(id => {
          const el = document.getElementById(id);
          if (!el) return { id, missing: true };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible = cs.display !== "none" && cs.visibility !== "hidden";
          const inView = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
          return { id, visible, inView, rect: { l: r.left.toFixed(0), t: r.top.toFixed(0), r: r.right.toFixed(0), b: r.bottom.toFixed(0) } };
        });
      });
      console.log(`  [title-buttons] ${fixture.name}:`);
      for (const b of btnRects) {
        if (b.missing) { console.log(`    ${b.id}: MISSING`); continue; }
        const status = b.visible && b.inView ? "✓ reachable" : b.visible ? "visible but off-screen" : "HIDDEN";
        console.log(`    ${b.id}: ${status}  rect(l=${b.rect.l} t=${b.rect.t} r=${b.rect.r} b=${b.rect.b})`);
      }
      await page.close();
    }

    // ---- Leaderboard tabs
    const tabs = [
      { slug: "high-score",     label: "score",  idx: pfx[1] },
      { slug: "highest-climb",  label: "climb",  idx: pfx[2] },
      { slug: "best-combo",     label: "combo",  idx: pfx[3] },
      { slug: "daily-score",    label: "daily",  idx: pfx[4] },
    ];
    for (const tab of tabs) {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "load" });
      await waitForTitle(page);
      results.push(await captureLeaderboardTab(page, fixDir, tab.idx, tab.slug, tab.label, tab.idx));
      await page.close();
    }

    // ---- Gameplay + pause
    {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "load" });
      await waitForTitle(page);
      const [gr, pr] = await captureGameplayAndPause(page, fixDir, pfx[5]);
      // Rename files to use correct numeric prefix
      results.push(gr);
      results.push(pr);
      await page.close();
    }

    // ---- Game over
    {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "load" });
      await waitForTitle(page);
      await page.evaluate(() => { const btn = document.getElementById("title-play-btn"); if (btn) btn.click(); });
      await page.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
      const goR = await captureGameOver(page, fixDir, pfx[7]);
      results.push(goR);

      // Check game-over button reachability
      const btnRects = await page.evaluate(() => {
        const ids = ["gameover-play-again", "gameover-title", "gameover-leaderboard", "share-score-btn"];
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        return ids.map(id => {
          const el = document.getElementById(id);
          if (!el) return { id, missing: true };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible = cs.display !== "none" && cs.visibility !== "hidden";
          const inView = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
          return { id, visible, inView, rect: { l: r.left.toFixed(0), t: r.top.toFixed(0), r: r.right.toFixed(0), b: r.bottom.toFixed(0) } };
        });
      });
      console.log(`  [gameover-buttons] ${fixture.name}:`);
      for (const b of btnRects) {
        if (b.missing) { console.log(`    ${b.id}: MISSING`); continue; }
        const status = b.visible && b.inView ? "✓ reachable" : b.visible ? "visible but off-screen" : "HIDDEN";
        console.log(`    ${b.id}: ${status}  rect(l=${b.rect.l} t=${b.rect.t} r=${b.rect.r} b=${b.rect.b})`);
      }
      await page.close();
    }
  } finally {
    await context.close();
  }
  return { fixture, results };
}

// -------- main ----------------------------------------------------------------

async function main() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    console.error("dist/index.html missing — run `npm run build` first");
    process.exit(2);
  }
  await ensureDir(OUT_ROOT);

  const server = startServer();
  await once(server, "listening");
  const { port } = server.address();
  console.log(`[mobile-audit] server on http://127.0.0.1:${port}`);

  const launchOpts = {};
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const browser = await chromium.launch({ ...launchOpts, headless: true });
  const allResults = [];
  try {
    for (const fx of FIXTURES) {
      console.log(`\n[mobile-audit] fixture: ${fx.name} (${fx.width}×${fx.height})`);
      const r = await runFixture(browser, fx, port, OUT_ROOT);
      allResults.push(r);
      for (const res of r.results) {
        const tag = res.passed ? "PASS" : "FAIL";
        console.log(`  [${tag}] ${res.label.padEnd(22)}  tracked=${res.trackedCount ?? "-"}  ${res.screenshot}`);
        for (const f of res.failures ?? []) {
          console.log(`         ↳ ${f}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  let fails = 0;
  for (const { results } of allResults) {
    for (const r of results) {
      if (!r.passed) fails += 1;
    }
  }
  console.log(`\n[mobile-audit] done — ${allResults.reduce((n, r) => n + r.results.length, 0)} screens, ${fails} failed`);

  // Write machine-readable summary for report generation
  const summaryPath = join(OUT_ROOT, "audit-results.json");
  await fs.writeFile(summaryPath, JSON.stringify(allResults, null, 2));
  console.log(`[mobile-audit] results written to ${summaryPath}`);

  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[mobile-audit] fatal:", err);
  process.exit(2);
});
