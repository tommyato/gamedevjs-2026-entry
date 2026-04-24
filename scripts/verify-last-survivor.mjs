#!/usr/bin/env node
/**
 * Regression guard for the VERSUS match-end resolver's last-survivor path.
 *
 * The test bundles the real MultiplayerManager against the in-memory platform
 * stub, then mutates the manager's internal match state directly. That keeps
 * the assertions deterministic and focused on the end-condition logic rather
 * than on network plumbing.
 *
 * Run: npm run verify:last-survivor
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, "test-stubs/name-sync-entry.ts");

const tmpDir = await fs.mkdtemp(join(tmpdir(), "cc-last-survivor-"));
const bundlePath = join(tmpDir, "last-survivor-bundle.mjs");

await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  logLevel: "error",
});

const mod = await import(bundlePath);
const { MultiplayerManager: MP, stubTransport } = mod;

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function makePeer(userId, username, { dead = false, finished = false, score = 0, height = 0, ms = 0 } = {}) {
  return {
    userId,
    username,
    x: 0,
    y: 0,
    z: 0,
    height,
    score,
    combo: 0,
    onGround: false,
    lastUpdate: 0,
    prevX: 0,
    prevY: 0,
    prevZ: 0,
    prevUpdate: 0,
    matchProgress: {
      ...(dead ? { dead: { score, height } } : {}),
      ...(finished ? { finished: { ms, score, height } } : {}),
    },
  };
}

function setupManager({
  localDead = false,
  localFinished = false,
  localScore = 0,
  localHeight = 0,
  localFinishMs = 0,
  firstFinisherGraceStart = null,
  peers = [],
  dnfPeers = [],
} = {}) {
  const mgr = new MP(stubTransport);
  const state = /** @type {any} */ (mgr);

  state.matchState = "in_match";
  state.matchEndFired = false;
  state.localStartAt = Date.now();
  state.localDead = localDead;
  state.localFinishedFlag = localFinished;
  state.localScore = localScore;
  state.localHeight = localHeight;
  state.localFinishMs = localFinishMs;
  state.firstFinisherGraceStart = firstFinisherGraceStart;
  state.peers = new Map(peers.map((peer) => [peer.userId, peer]));
  state.dnfPeers = dnfPeers.slice();

  return mgr;
}

// Case 1: 3-player match, two peers dead, local alive, none finished.
{
  const resultsSeen = [];
  const mgr = setupManager({
    localScore: 100,
    localHeight: 30,
    peers: [
      makePeer("peer-a", "peer-a", { dead: true, score: 40, height: 10 }),
      makePeer("peer-b", "peer-b", { dead: true, score: 20, height: 5 }),
    ],
  });
  const state = /** @type {any} */ (mgr);
  mgr.setCallbacks({ onMatchEnded: (results) => resultsSeen.push(results) });

  state["tickMatchEnd"]();

  assert(state.matchEndFired === true, "case 1: last survivor should fire match end immediately");
  assert(resultsSeen.length === 1, "case 1: match end callback should fire exactly once");
  const results = resultsSeen[0] ?? [];
  assert(results.length === 3, `case 1: expected 3 results, got ${results.length}`);
  assert(results[0]?.userId === "local", `case 1: local survivor should rank #1, got ${results[0]?.userId}`);
  assert(results[0]?.rank === 1, `case 1: local survivor should have rank 1, got ${results[0]?.rank}`);
  assert(results[0]?.finished === false, "case 1: local survivor should be marked unfinished");
  assert(results[0]?.isLocal === true, "case 1: local survivor should still be flagged as local");
}

// Case 2: 3-player match, one peer dead + one alive, local alive -> no end.
{
  const mgr = setupManager({
    localScore: 80,
    localHeight: 20,
    peers: [
      makePeer("peer-a", "peer-a", { dead: true, score: 15, height: 4 }),
      makePeer("peer-b", "peer-b", { score: 60, height: 14 }),
    ],
  });
  const state = /** @type {any} */ (mgr);
  mgr.setCallbacks({ onMatchEnded: () => {
    throw new Error("case 2: match end should not fire with two survivors");
  }});

  state["tickMatchEnd"]();

  assert(state.matchEndFired === false, "case 2: two surviving participants should not auto-end");
  assert(state.matchState === "in_match", "case 2: match state should remain in_match");
}

// Case 3: 2-player match, peer finished, local alive -> last-survivor path must stay out of the way.
{
  const mgr = setupManager({
    localScore: 70,
    localHeight: 18,
    firstFinisherGraceStart: Date.now(),
    peers: [makePeer("peer-a", "peer-a", { finished: true, ms: 12345, score: 90, height: 25 })],
  });
  const state = /** @type {any} */ (mgr);
  mgr.setCallbacks({ onMatchEnded: () => {
    throw new Error("case 3: grace-period path should be the only end mechanism here");
  }});

  state["tickMatchEnd"]();

  assert(state.matchEndFired === false, "case 3: finished peer should suppress last-survivor auto-end");
  assert(state.matchState === "in_match", "case 3: grace window should keep match running");
}

// Case 4: solo match, local alive -> no insta-end.
{
  const mgr = setupManager({
    localScore: 55,
    localHeight: 12,
  });
  const state = /** @type {any} */ (mgr);
  mgr.setCallbacks({ onMatchEnded: () => {
    throw new Error("case 4: solo match should not insta-end");
  }});

  state["tickMatchEnd"]();

  assert(state.matchEndFired === false, "case 4: solo match must not auto-end as last survivor");
  assert(state.matchState === "in_match", "case 4: solo match should stay in progress");
}

// Case 5: 3-player match, all three dead -> existing all-dead path still wins.
{
  const mgr = setupManager({
    localDead: true,
    localScore: 10,
    localHeight: 2,
    peers: [
      makePeer("peer-a", "peer-a", { dead: true, score: 15, height: 4 }),
      makePeer("peer-b", "peer-b", { dead: true, score: 12, height: 3 }),
    ],
  });
  const state = /** @type {any} */ (mgr);

  state["tickMatchEnd"]();

  assert(state.matchEndFired === true, "case 5: all-dead match should still fire match end");
}

await fs.rm(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\nlast-survivor verification FAILED: ${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`last-survivor verification passed: ${passed} assertions.`);
