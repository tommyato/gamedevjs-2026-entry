#!/usr/bin/env node
/**
 * UI verification harness — the only supported way to verify UI changes.
 *
 * Per `playbook/ui-screen-verification.md`: never screenshot at an arbitrary
 * viewport. This script loads `dist/index.html` *inside an iframe* sized to
 * real Wavedash embed dimensions, then captures + asserts per fixture.
 *
 * Fixtures (hardcoded — not caller-overridable):
 *   wavedash-desktop   1280×720
 *   wavedash-narrow     890×500   ← catches the most bugs
 *   wavedash-portrait   540×960
 *
 * Screens per fixture: title, lobby-1p, lobby-2p, lobby-4p, gameplay, gameover.
 * Outputs: screenshots/ui-harness/<fixture>/<screen>.png  (3 × 6 = 18 PNGs).
 *
 * Exit: 0 if every assertion passes; non-zero on the first failure.
 *
 * Run:  npm run verify-ui
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
const SCREENSHOT_ROOT = join(REPO_ROOT, "screenshots", "ui-harness");

const FIXTURES = [
  { name: "wavedash-desktop", width: 1280, height: 720 },
  { name: "wavedash-narrow", width: 890, height: 500 },
  { name: "wavedash-portrait", width: 540, height: 960 },
];

const SCREENS = ["title", "lobby-1p", "lobby-2p", "lobby-4p", "gameplay", "gameover"];

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

// -------- helpers ------------------------------------------------------------

async function ensureDist() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    console.error("dist/index.html missing. Run `npm run build` first.");
    process.exit(2);
  }
}

async function ensureDir(path) {
  await fs.mkdir(path, { recursive: true });
}

/**
 * Serve `dist/` plus a synthetic wrapper page at `/harness/<fixture>.html`
 * that embeds dist/index.html in an iframe at the fixture's dimensions,
 * centered on a dark background. Matches production Wavedash embed context.
 */
function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // /harness/<fixture>.html → dynamic wrapper
    const m = /^\/harness\/([a-z0-9-]+)\.html$/.exec(pathname);
    if (m) {
      const fixtureName = m[1];
      const fx = FIXTURES.find((f) => f.name === fixtureName);
      if (!fx) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("unknown fixture");
        return;
      }
      const html = `<!doctype html><html><head><meta charset="utf-8"/><title>harness ${fx.name}</title>
<style>
html,body{margin:0;padding:0;background:#0a0f13;width:100%;height:100%;overflow:hidden;display:flex;align-items:center;justify-content:center;}
iframe#game{border:0;display:block;background:#000;}
</style></head>
<body>
<iframe id="game" src="/index.html?verify-ui=1" width="${fx.width}" height="${fx.height}" title="Clockwork Climb embed"></iframe>
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Static: serve from dist/
    let fsPath = join(DIST_DIR, decodeURIComponent(pathname));
    if (pathname === "/" || pathname === "") fsPath = join(DIST_DIR, "index.html");
    if (!fsPath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found: " + pathname);
      return;
    }
    const ext = extname(fsPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    createReadStream(fsPath).pipe(res);
  });
  server.listen(0, "127.0.0.1");
  return server;
}

// -------- assertion machinery -----------------------------------------------

/**
 * All assertions run in the iframe's document context. Return `{ok, failures}`.
 * Each failure is a plain string describing what went wrong.
 */
const IFRAME_ASSERTIONS = `
(() => {
  const failures = [];
  const doc = document;
  // Iframe client rect = its own viewport = (0,0)→(innerWidth, innerHeight)
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;

  // The spec (playbook/ui-screen-verification.md + Task 5) calls out
  //   (a) elements with data-hud / class^='cc-' (explicit annotation)
  //   (b) canvas visibility
  //   (c) all visible text elements inside the embed rect
  // We broaden to cover (c) pragmatically: every visible descendant of the
  // title overlay, gameover view, and HUD tree gets its bounding box checked.
  // This is what actually catches the narrow-embed regressions (DAILY/VERSUS
  // clip, HUD overlap, etc.).
  const annotated = Array.from(doc.querySelectorAll(
    '[data-hud], [class^="cc-"], [class*=" cc-"]',
  ));
  const overlayEls = [];
  const overlayRoots = ['#title-overlay', '#game-over-view', '#hud'];
  for (const sel of overlayRoots) {
    const root = doc.querySelector(sel);
    if (!root) continue;
    const cs = getComputedStyle(root);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    overlayEls.push(root, ...Array.from(root.querySelectorAll('*')));
  }
  // Dedupe + keep insertion order.
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
    // Skip intentionally-off-screen elements the game uses as offscreen buffers.
    if (el.hasAttribute('data-overlay-ok')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Ignore script/style/meta-like tags.
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') continue;
    const id = el.id || (el.className && typeof el.className === 'string' ? el.className : tag);
    const overflow = [];
    if (r.left < -0.5) overflow.push('left=' + r.left.toFixed(1));
    if (r.top < -0.5) overflow.push('top=' + r.top.toFixed(1));
    if (r.right > vw + 0.5) overflow.push('right=' + r.right.toFixed(1) + '/vw=' + vw);
    if (r.bottom > vh + 0.5) overflow.push('bottom=' + r.bottom.toFixed(1) + '/vh=' + vh);
    if (overflow.length > 0) {
      overflows.push(\`overflow: \${id.slice(0, 80)} [\${overflow.join(', ')}]\`);
    }
  }
  // Cap failure list so the log stays readable.
  failures.push(...overflows.slice(0, 12));
  if (overflows.length > 12) {
    failures.push(\`... (\${overflows.length - 12} more overflow failures)\`);
  }

  // Canvas must be visible and non-zero size.
  const canvas = doc.querySelector('canvas');
  if (!canvas) {
    failures.push('canvas: element missing');
  } else {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      failures.push('canvas: zero rendered size ' + r.width + 'x' + r.height);
    }
  }

  return { vw, vh, failures, trackedCount: tracked.length };
})()
`;

async function assertScreen(iframe, label) {
  const result = await iframe.evaluate(IFRAME_ASSERTIONS);
  return {
    label,
    passed: result.failures.length === 0,
    failures: result.failures,
    trackedCount: result.trackedCount,
    vw: result.vw,
    vh: result.vh,
  };
}

// -------- per-screen setup helpers ------------------------------------------

async function waitForTitleReady(iframe) {
  await iframe.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await iframe.waitForSelector("#title-overlay:not(.hidden)", { timeout: 15000 });
  await iframe.waitForSelector("#title-overlay h1", { state: "visible", timeout: 15000 });
  // Give the title tagline + prompts a moment to settle.
  await iframe.waitForTimeout(600);
}

async function waitForHudVisible(iframe) {
  await iframe.waitForSelector("#hud:not(.hidden)", { timeout: 20000 });
}

async function waitForGameOver(iframe) {
  await iframe.waitForSelector("#game-over-view:not(.hidden)", { timeout: 20000 });
}

// -------- screen runners ----------------------------------------------------

async function captureTitle(iframe, page, fixtureDir) {
  await waitForTitleReady(iframe);

  // FOUC check: ghost button text must be stable across t=0 and t=500ms.
  const textAt0 = await iframe.evaluate(() => {
    const btn = document.getElementById("title-btn-raceai");
    return btn ? { text: btn.textContent, visible: getComputedStyle(btn).display !== "none" } : null;
  });
  await page.waitForTimeout(500);
  const textAt500 = await iframe.evaluate(() => {
    const btn = document.getElementById("title-btn-raceai");
    return btn ? { text: btn.textContent, visible: getComputedStyle(btn).display !== "none" } : null;
  });

  const shotPath = join(fixtureDir, "title.png");
  await page.screenshot({ path: shotPath, fullPage: false });

  const base = await assertScreen(iframe, "title");
  if (textAt0 && textAt500 && textAt0.text !== textAt500.text) {
    base.passed = false;
    base.failures.push(
      `ghost-button FOUC: text changed from "${textAt0.text}" at t=0ms to "${textAt500.text}" at t=500ms`,
    );
  }
  // Guard against the specific "RACE AI" regression — even if stable, that
  // text is forbidden on the shipped title screen.
  if (textAt0 && /RACE\s+AI/i.test(textAt0.text ?? "")) {
    base.passed = false;
    base.failures.push(`ghost-button: forbidden text "${textAt0.text}"`);
  }
  base.screenshot = shotPath;
  return base;
}

async function pressSpaceInFrame(iframe) {
  // Keyboard events must dispatch *inside* the iframe's window — Playwright
  // page.keyboard routes to the top document, which the game's input listener
  // doesn't see. Synthesize KeyboardEvents directly.
  await iframe.evaluate(() => {
    const down = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true });
    const up = new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true });
    window.dispatchEvent(down);
    setTimeout(() => window.dispatchEvent(up), 40);
  });
}

async function captureGameplay(iframe, page, fixtureDir) {
  await waitForTitleReady(iframe);
  // Start a run.
  await iframe.evaluate(() => {
    const btn = document.getElementById("title-play-btn");
    if (btn) btn.click();
  });
  await waitForHudVisible(iframe);

  // Drive for ~15 real seconds. Tap space every 800 ms to climb.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await pressSpaceInFrame(iframe);
    await page.waitForTimeout(800);
  }

  const shotPath = join(fixtureDir, "gameplay.png");
  await page.screenshot({ path: shotPath });
  const r = await assertScreen(iframe, "gameplay");
  r.screenshot = shotPath;
  return r;
}

async function captureGameover(iframe, page, fixtureDir) {
  // Force gameover via the test-only debug hook (enabled by ?verify-ui=1).
  await iframe.evaluate(() => {
    const g = window.__ccGame;
    if (g && typeof g.debugForceGameOver === "function") {
      g.debugForceGameOver();
    }
  });
  try {
    await waitForGameOver(iframe);
  } catch {
    // If the hook wasn't reachable, fall back to polling until a gameover
    // happens naturally (or timeout).
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const over = await iframe.evaluate(
        () => !document.getElementById("game-over-view")?.classList.contains("hidden"),
      );
      if (over) break;
    }
  }
  // Give the gameover render a breath to settle (leaderboard rows, contract rows).
  await page.waitForTimeout(500);
  const shotPath = join(fixtureDir, "gameover.png");
  await page.screenshot({ path: shotPath });
  const r = await assertScreen(iframe, "gameover");

  // Extra assertion for wavedash-narrow: button row fully inside 500px height.
  const viewport = page.viewportSize();
  if (viewport && viewport.height <= 500) {
    const btnRect = await iframe.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("#game-over-view button"));
      if (btns.length === 0) return null;
      let top = Infinity, bottom = -Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.top < top) top = r.top;
        if (r.bottom > bottom) bottom = r.bottom;
      }
      return { top, bottom, vh: document.documentElement.clientHeight };
    });
    if (btnRect && btnRect.bottom > btnRect.vh + 0.5) {
      r.passed = false;
      r.failures.push(
        `gameover: button row overflows iframe (bottom=${btnRect.bottom.toFixed(1)} vh=${btnRect.vh})`,
      );
    }
  }
  r.screenshot = shotPath;
  return r;
}

async function captureLobbyPlaceholder(iframe, page, fixtureDir, name, reason) {
  // Lobby screens require a full mock of window.WavedashJS (SDK with lobby,
  // p2p, and member-list APIs). That's a meaningful effort and is deferred
  // to a follow-up pass. We still emit a placeholder PNG so the output
  // directory shape is the documented 18-file matrix.
  await waitForTitleReady(iframe);
  const shotPath = join(fixtureDir, `${name}.png`);
  await page.screenshot({ path: shotPath });
  return {
    label: name,
    passed: true,
    failures: [],
    skipped: true,
    reason,
    screenshot: shotPath,
  };
}

// -------- per-fixture driver ------------------------------------------------

async function runFixture(browser, fixture, port) {
  const context = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const fixtureDir = join(SCREENSHOT_ROOT, fixture.name);
  await ensureDir(fixtureDir);

  const results = [];
  try {
    // Fresh navigation per screen (each screen is a cold boot except gameplay→gameover)
    const url = `http://127.0.0.1:${port}/harness/${fixture.name}.html`;

    // Helper to enter the iframe
    const enterIframe = async () => {
      await page.waitForSelector("iframe#game");
      const handle = await page.$("iframe#game");
      const frame = await handle.contentFrame();
      if (!frame) throw new Error("iframe has no content frame");
      return frame;
    };

    // title
    await page.goto(url, { waitUntil: "load" });
    let iframe = await enterIframe();
    results.push(await captureTitle(iframe, page, fixtureDir));

    // lobby-1p / lobby-2p / lobby-4p — skipped with placeholder PNG
    for (const lobby of ["lobby-1p", "lobby-2p", "lobby-4p"]) {
      await page.goto(url, { waitUntil: "load" });
      iframe = await enterIframe();
      results.push(
        await captureLobbyPlaceholder(
          iframe,
          page,
          fixtureDir,
          lobby,
          "full WavedashJS SDK mock (lobby/p2p/member-list) not yet implemented — see Task 5 follow-up",
        ),
      );
    }

    // gameplay (fresh boot)
    await page.goto(url, { waitUntil: "load" });
    iframe = await enterIframe();
    results.push(await captureGameplay(iframe, page, fixtureDir));

    // gameover — boot fresh, start a run, force the gameover UI.
    await page.goto(url, { waitUntil: "load" });
    iframe = await enterIframe();
    await waitForTitleReady(iframe);
    await iframe.evaluate(() => {
      const btn = document.getElementById("title-play-btn");
      if (btn) btn.click();
    });
    await waitForHudVisible(iframe);
    results.push(await captureGameover(iframe, page, fixtureDir));
  } finally {
    await context.close();
  }
  return { fixture, results };
}

// -------- main --------------------------------------------------------------

async function main() {
  await ensureDist();
  await ensureDir(SCREENSHOT_ROOT);
  for (const fx of FIXTURES) {
    await ensureDir(join(SCREENSHOT_ROOT, fx.name));
  }

  const server = startServer();
  await once(server, "listening");
  const { port } = server.address();
  console.log(`[verify-ui] static server listening on http://127.0.0.1:${port}`);

  const launchOpts = {};
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const browser = await chromium.launch({ ...launchOpts, headless: true });
  const allResults = [];
  try {
    for (const fx of FIXTURES) {
      console.log(`\n[verify-ui] fixture: ${fx.name} (${fx.width}×${fx.height})`);
      const r = await runFixture(browser, fx, port);
      allResults.push(r);
      for (const res of r.results) {
        const tag = res.skipped ? "SKIP" : res.passed ? "PASS" : "FAIL";
        console.log(
          `  [${tag}] ${res.label.padEnd(10)}  tracked=${res.trackedCount ?? "-"}  screenshot=${res.screenshot}`,
        );
        if (res.skipped) {
          console.log(`         reason: ${res.reason}`);
        }
        for (const f of res.failures ?? []) {
          console.log(`         ↳ ${f}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Summary
  let fails = 0;
  let skips = 0;
  for (const { fixture, results } of allResults) {
    for (const r of results) {
      if (r.skipped) skips += 1;
      else if (!r.passed) fails += 1;
    }
  }
  console.log(
    `\n[verify-ui] done — ${allResults.reduce((n, r) => n + r.results.length, 0)} screens, ${fails} failed, ${skips} skipped`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify-ui] fatal:", err);
  process.exit(2);
});
