/**
 * Remote ghost client for Clockwork Climb.
 *
 * Mirrors Shatter Drift's `leaderboard.ts` ghost helpers, scoped to the
 * multi-game endpoint `/games/clockwork-climb/ghosts` on api.tommyato.com.
 *
 * The server stores frames opaquely. Wire format here is a small adapter:
 *   server row   { id, name, score, distance, grade, seed, frames, ts }
 *   CC GhostRecord { id, name, seed, score, height, durationMs, frames }
 *
 * We pack `height` into the server's `distance` column on submit, and unpack
 * it back on fetch. `seed` is sent and fetched so each ghost brings its own
 * tower layout; old rows without seed fall back to CHALLENGE_SEED. `durationMs`
 * is recovered from the last frame's timestamp.
 */

import type { GhostFrame, GhostRecord } from "./ghost-recorder";
import { CHALLENGE_SEED } from "./ghost-recorder";
import type { IPlatformServices } from "./platform-services";

const API_URL = "https://api.tommyato.com";
const GAME_ID = "clockwork-climb";

type ServerGhostRow = {
  id?: unknown;
  name?: unknown;
  score?: unknown;
  distance?: unknown;
  grade?: unknown;
  seed?: unknown;
  frames?: unknown;
  ts?: unknown;
};

function adaptServerGhost(row: ServerGhostRow): GhostRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.score !== "number" ||
    !Array.isArray(row.frames) ||
    row.frames.length < 2
  ) {
    return null;
  }
  const frames = row.frames as GhostFrame[];
  const last = frames[frames.length - 1];
  const durationMs = typeof last?.t === "number" ? last.t : 0;
  const height = typeof row.distance === "number" ? row.distance : 0;
  // Prefer the stored seed; fall back to CHALLENGE_SEED for old rows that
  // predate per-run seed storage.
  const seed = typeof row.seed === "number" ? row.seed : CHALLENGE_SEED;
  return {
    id: row.id,
    name: row.name,
    seed,
    score: row.score,
    height,
    durationMs,
    frames,
  };
}

/** Top N ghosts for CC, score-descending. Silent on failure (returns []). */
export async function fetchGhosts(limit = 5): Promise<GhostRecord[]> {
  try {
    const res = await fetch(`${API_URL}/games/${GAME_ID}/ghosts?limit=${limit}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = (data?.ghosts ?? []) as ServerGhostRow[];
    const out: GhostRecord[] = [];
    for (const row of rows) {
      const rec = adaptServerGhost(row);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/** Upload a ghost recording. Returns server id or null on any failure.
 *  `height` is sent in the server's `distance` slot — see file header.
 *  `seed` is stored so playback can reconstruct the exact tower layout. */
export async function submitGhost(entry: {
  name: string;
  score: number;
  height: number;
  seed: number;
  frames: GhostFrame[];
}): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/games/${GAME_ID}/ghosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: entry.name,
        score: entry.score,
        distance: Math.round(entry.height),
        grade: "",
        seed: entry.seed,
        frames: entry.frames,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Score threshold for ghost uploads — the 10th-place score on the CC
 * high-score leaderboard, or 0 if CC hasn't filled the top 10 yet (in
 * which case upload everything so the pool can bootstrap).
 */
export async function fetchGhostUploadThreshold(platform: IPlatformServices): Promise<number> {
  try {
    const scores = await platform.fetchLeaderboardScores("high-score");
    if (!Array.isArray(scores) || scores.length < 10) return 0;
    const sorted = scores.slice().sort((a, b) => b.score - a.score);
    return sorted[9]?.score || 0;
  } catch {
    return 0;
  }
}

/** Uniform random pick from an array, or undefined if empty. */
export function pickRandom<T>(arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}
