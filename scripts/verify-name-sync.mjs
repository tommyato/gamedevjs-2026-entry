#!/usr/bin/env node
/**
 * Name-propagation regression guard for MultiplayerManager.
 *
 * Reproduces the Build #48 bug: the host edits their name to "supertommy"
 * before a peer joins. On peer connect the host pushes a NAME_UPDATE. At
 * that moment the peer has no row for the host in its `peers` map (STATE
 * broadcasts are gated to gameplay), so a naive implementation drops the
 * message and the peer's lobby roster falls back to the SDK coolname.
 *
 * This test pins that path: it spins up two real MultiplayerManager
 * instances against an in-memory platform stub (no browser, no SDK), fires
 * the host's peer-connect NAME_UPDATE, and asserts the receiver surfaces
 * the custom name in `getLobbyRoster()` and in its internal peer row after
 * the first STATE tick materialises the peer.
 *
 * Run: npm run verify:name-sync
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, "test-stubs/name-sync-entry.ts");

// Build the test entry into an ESM bundle. Since Phase 1's IPlatformServices
// refactor, MultiplayerManager takes its transport via constructor — no more
// esbuild resolve hijack of `./platform`. The stub exports a transport object
// that implements IMultiplayerTransport directly.
const tmpDir = await fs.mkdtemp(join(tmpdir(), "cc-name-sync-"));
const bundlePath = join(tmpDir, "name-sync-bundle.mjs");

await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  logLevel: "error",
});

const mod = await import(bundlePath);
const {
  MultiplayerManager: MP,
  __resetHarness,
  __setCurrentUser,
  __fireP2PConnected,
  __asUser,
  stubTransport,
} = mod;

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

// ── Test: NAME_UPDATE arrives before any STATE (the Build #48 regression) ───

__resetHarness();
// Host is userA with SDK coolname "coolname-A"; their custom display name
// will be set to "supertommy". Peer is userB with SDK coolname "coolname-B".
__setCurrentUser("userA", "coolname-A");
__setCurrentUser("userB", "coolname-B");

// Construct both managers. createLobby / joinLobby need the current-user tag
// so ensureListeners binds the host's P2P_CONNECTION_ESTABLISHED callback
// under "userA" in the stub.
const hostMgr = new MP(stubTransport);
hostMgr.setCallbacks({ getLocalName: () => "supertommy" });
hostMgr.setLocalName("supertommy");

const peerMgr = new MP(stubTransport);

await __asUser("userA", () => hostMgr.createLobby());
await __asUser("userB", () => peerMgr.joinLobby("test-lobby"));

// Sanity check: before any NAME_UPDATE, peer sees host's SDK coolname.
{
  const roster = __asUser("userB", () => peerMgr.getLobbyRoster());
  const hostEntry = roster.find((r) => r.userId === "userA");
  assert(hostEntry !== undefined, "pre-name-update: host should appear in peer's roster");
  assert(
    hostEntry?.username === "coolname-A",
    `pre-name-update: expected SDK coolname "coolname-A", got "${hostEntry?.username}"`
  );
}

// Simulate the P2P connection: fires the host's listener (under userA), which
// pushes NAME_UPDATE. The stub queues the payload into userB's inbox. The
// peer manager drains next.
__fireP2PConnected("userA");

// Peer drains its inbound queue. Before the fix, handleNameUpdate early-
// returned because peer row was absent, and the name was lost. After the
// fix, pendingNames caches "supertommy".
__asUser("userB", () => peerMgr.pollPeers(0.05));

// Assertion 1: getLobbyRoster surfaces the custom name, not the coolname.
{
  const roster = __asUser("userB", () => peerMgr.getLobbyRoster());
  const hostEntry = roster.find((r) => r.userId === "userA");
  assert(hostEntry !== undefined, "post-name-update: host should still appear in peer's roster");
  assert(
    hostEntry?.username === "supertommy",
    `lobby-phase NAME_UPDATE should set roster name to "supertommy", got "${hostEntry?.username}"`
  );
}

// Assertion 2: when STATE later materialises the peer (gameplay starts),
// the cached name flows into the peers map so in-world labels pick up the
// custom name too.
__asUser("userA", () => {
  hostMgr.update(0.1, 0, 0, 0, 0, 0, 0, true);
});
__asUser("userB", () => peerMgr.pollPeers(0.1));

{
  const peers = peerMgr.getPeers();
  const hostRow = peers.find((p) => p.userId === "userA");
  assert(hostRow !== undefined, "post-state: peer should have a row for the host");
  assert(
    hostRow?.username === "supertommy",
    `peer row username should be "supertommy" (from pendingNames), got "${hostRow?.username}"`
  );
}

// Assertion 3: a second NAME_UPDATE after the peer row exists still updates
// the row (retains live-rename behaviour).
__asUser("userA", () => {
  hostMgr.sendNameUpdate("supertommy-v2");
});
__asUser("userB", () => peerMgr.pollPeers(0.05));
{
  const peers = peerMgr.getPeers();
  const hostRow = peers.find((p) => p.userId === "userA");
  assert(
    hostRow?.username === "supertommy-v2",
    `live rename should update peer row to "supertommy-v2", got "${hostRow?.username}"`
  );
}

// Assertion 4: empty/whitespace NAME_UPDATE is rejected; peer row keeps last name.
__asUser("userA", () => {
  hostMgr.sendNameUpdate("   ");
});
__asUser("userB", () => peerMgr.pollPeers(0.05));
{
  const peers = peerMgr.getPeers();
  const hostRow = peers.find((p) => p.userId === "userA");
  assert(
    hostRow?.username === "supertommy-v2",
    `empty NAME_UPDATE must not overwrite; got "${hostRow?.username}"`
  );
}

// ── Cleanup + report ───────────────────────────────────────────────────────
await fs.rm(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\nname-sync verification FAILED: ${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`name-sync verification passed: ${passed} assertions.`);
