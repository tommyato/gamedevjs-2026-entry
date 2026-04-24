/**
 * Verifies that the FNV-1a lobby-id hash used in MultiplayerManager.getSyncedSeed()
 * is deterministic, collision-resistant across typical lobby ids, and always
 * produces a value in the Uint32 range [0, 2^32).
 *
 * The hash function is duplicated inline here (same algorithm as multiplayer.ts)
 * so this script has zero build dependencies.
 */

// FNV-1a 32-bit hash — must stay in sync with MultiplayerManager.getSyncedSeed()
function hashLobbyId(lobbyId) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < lobbyId.length; i++) {
    hash ^= lobbyId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

// 1. Determinism — same lobby id always produces the same seed
const deterministicIds = [
  "lobby-abc-123",
  "00000000-0000-4000-8000-000000000001",
  "xyzzy-lobby",
];
for (const id of deterministicIds) {
  const s1 = hashLobbyId(id);
  const s2 = hashLobbyId(id);
  assert(s1 === s2, `determinism: hashLobbyId("${id}") is not stable: ${s1} vs ${s2}`);
}

// 2. Collision-resistance — 10 distinct uuid-ish lobby ids produce distinct seeds
const collisionIds = [
  "lobby-00000000-0000-4000-8000-000000000001",
  "lobby-00000000-0000-4000-8000-000000000002",
  "lobby-00000000-0000-4000-8000-000000000003",
  "lobby-00000000-0000-4000-8000-000000000004",
  "lobby-00000000-0000-4000-8000-000000000005",
  "lobby-00000000-0000-4000-8000-000000000006",
  "lobby-00000000-0000-4000-8000-000000000007",
  "lobby-00000000-0000-4000-8000-000000000008",
  "lobby-00000000-0000-4000-8000-000000000009",
  "lobby-00000000-0000-4000-8000-00000000000a",
];
const seeds = collisionIds.map(hashLobbyId);
const uniqueSeeds = new Set(seeds);
assert(
  uniqueSeeds.size === collisionIds.length,
  `collision: expected ${collisionIds.length} distinct seeds, got ${uniqueSeeds.size} (seeds: ${seeds.join(", ")})`
);

// 3. Uint32 range — every seed is a non-negative integer less than 2^32
const rangeIds = [...deterministicIds, ...collisionIds];
for (const id of rangeIds) {
  const seed = hashLobbyId(id);
  assert(
    Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32,
    `range: hashLobbyId("${id}") = ${seed} is not a Uint32`
  );
}

if (failed > 0) {
  console.error(`\nmp-seed-sync verification FAILED: ${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`mp-seed-sync verification passed: ${passed} assertions.`);
