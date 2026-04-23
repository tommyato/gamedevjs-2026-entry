/**
 * Ghost Recorder — records the player's position over time during a run so the
 * frames can be saved to JSON, checked into the repo, and played back as a
 * translucent "ghost" for other players to race against (async multiplayer).
 *
 * Modeled after Shatter Drift's `src/ghost.ts` (`GhostRecorder` / `GhostRecord`).
 * Clockwork Climb is a vertical tower-climb, so we store `x, y, z` directly —
 * the simulation already exposes Cartesian world coords on `SimPlayer`.
 *
 * Capture mode: add `?capture=1` to the URL. On death/finish the recording is
 * logged to the console and offered as a downloadable `ghost-challenge.json`.
 *
 * Playback mode: Tommy drops the recorded JSON at `public/ghost-challenge.json`,
 * flips `GHOST_CHALLENGE_READY` on in `game.ts`, and the PLAY A GHOST button
 * becomes available on the title screen. The challenge run uses `CHALLENGE_SEED`
 * so the gear layout matches what the ghost recorded on.
 */

/** Compact per-frame record. ~35 bytes as JSON at 2 decimals. */
export interface GhostFrame {
  /** World X */
  x: number;
  /** World Y (height) */
  y: number;
  /** World Z */
  z: number;
  /** 1 if on ground this frame, 0 if airborne. Small visual cue for playback. */
  g: 0 | 1;
  /** Milliseconds since run start. */
  t: number;
}

/** Metadata + frames for a complete recording. */
export interface GhostRecord {
  /** Stable id — e.g. "tommy-2026-04-23" */
  id: string;
  /** Display name, shown in the HUD while racing */
  name: string;
  /** Seed the run was played on — must match the challenge seed at playback */
  seed: number;
  /** Final score reached */
  score: number;
  /** Highest Y reached (metres) */
  height: number;
  /** Total run duration in ms */
  durationMs: number;
  /** Recorded frames at ~10Hz */
  frames: GhostFrame[];
}

/**
 * Fixed seed for the PLAY A GHOST challenge run. Everyone races the same
 * tower layout so Tommy's recorded ghost sees the same gears they saw. The
 * recorder captures this seed into the JSON; playback verifies it and falls
 * back gracefully if mismatched.
 *
 * Value chosen as a pun on "CLOCC WRK": 0xC10CC00C.
 */
export const CHALLENGE_SEED = 0xc10cc00c;

/** Sample cadence: 10Hz keeps files tiny (~600 frames for a 60s run). */
const SAMPLE_INTERVAL_MS = 100;

export class GhostRecorder {
  private frames: GhostFrame[] = [];
  private startTime = 0;
  private lastSampleTime = 0;
  private recording = false;

  start(): void {
    this.frames = [];
    this.startTime = performance.now();
    // Force the very first sample on the next `sample()` call.
    this.lastSampleTime = this.startTime - SAMPLE_INTERVAL_MS;
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Sample the player's current position. Cheap to call every frame — it
   * rate-limits internally to 10Hz.
   */
  sample(x: number, y: number, z: number, onGround: boolean): void {
    if (!this.recording) return;
    const now = performance.now();
    if (now - this.lastSampleTime < SAMPLE_INTERVAL_MS) return;
    this.lastSampleTime = now;
    this.frames.push({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
      g: onGround ? 1 : 0,
      t: Math.round(now - this.startTime),
    });
  }

  getFrames(): GhostFrame[] {
    return this.frames;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** ms since `start()` for the most recent sample, or 0 if none. */
  get durationMs(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].t : 0;
  }

  /**
   * Build a self-contained GhostRecord for download / commit.
   */
  buildRecord(opts: {
    id: string;
    name: string;
    seed: number;
    score: number;
    height: number;
  }): GhostRecord {
    return {
      id: opts.id,
      name: opts.name,
      seed: opts.seed,
      score: opts.score,
      height: opts.height,
      durationMs: this.durationMs,
      frames: this.frames.slice(),
    };
  }
}

/** Check for `?capture=1` or `?capture=true` in the URL. */
export function isCaptureModeEnabled(): boolean {
  try {
    const p = new URLSearchParams(window.location.search).get("capture");
    return p === "1" || p === "true";
  } catch {
    return false;
  }
}

/**
 * Trigger a browser download of a GhostRecord as JSON. Also logs the JSON to
 * the console so it can be copy-pasted from headless environments.
 */
export function downloadGhostRecord(record: GhostRecord, filename = "ghost-challenge.json"): void {
  const json = JSON.stringify(record);
  console.log(`[ghost-recorder] Captured ${record.frames.length} frames (${record.durationMs}ms, ${record.height}m, seed 0x${record.seed.toString(16)}).`);
  console.log("[ghost-recorder] JSON payload follows — copy into public/ghost-challenge.json:");
  console.log(json);
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("[ghost-recorder] Download failed (expected in headless):", err);
  }
}
