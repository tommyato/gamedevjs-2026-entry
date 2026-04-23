/**
 * Ghost Playback — renders a translucent figure following a recorded run.
 *
 * Takes a `GhostRecord` (loaded from `public/ghost-challenge.json`) and
 * interpolates position each tick. Pure positional lerp — no simulation,
 * no physics, no collision. Visual-only.
 */

import * as THREE from "three";
import type { GhostFrame, GhostRecord } from "./ghost-recorder";

const GHOST_COLOR = 0x9bd8ff;
const GHOST_OPACITY = 0.45;

export class GhostPlayback {
  private scene: THREE.Scene;
  private record: GhostRecord;
  private group: THREE.Group;
  private bodyMaterial: THREE.MeshStandardMaterial;
  /** Run time in seconds since the current run started. */
  private runTime = 0;
  private lastFrameIdx = 0;
  private finished = false;
  private playing = false;

  constructor(scene: THREE.Scene, record: GhostRecord) {
    this.scene = scene;
    this.record = record;

    const group = new THREE.Group();

    // Body — translucent cylinder matching the player's rough silhouette, so
    // the ghost reads as "another climber" without hiding live gameplay.
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 14);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: GHOST_COLOR,
      emissive: GHOST_COLOR,
      emissiveIntensity: 0.8,
      metalness: 0.2,
      roughness: 0.4,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    });
    const body = new THREE.Mesh(bodyGeo, this.bodyMaterial);
    body.position.y = 0.3;
    group.add(body);

    // A small halo above so the ghost is visible against busy gear geometry.
    const haloGeo = new THREE.TorusGeometry(0.42, 0.04, 8, 20);
    const haloMat = new THREE.MeshBasicMaterial({
      color: GHOST_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.72;
    group.add(halo);

    group.visible = false;
    this.group = group;
    this.scene.add(group);

    // Initialise position to the first frame so the ghost spawns in the right
    // place, not at the origin.
    if (record.frames.length > 0) {
      const f = record.frames[0];
      this.group.position.set(f.x, f.y, f.z);
    }
  }

  /** Start playback at `t = 0`. Called at the start of a challenge run. */
  start(): void {
    this.runTime = 0;
    this.lastFrameIdx = 0;
    this.finished = false;
    this.playing = true;
    this.bodyMaterial.opacity = GHOST_OPACITY;
    if (this.record.frames.length > 0) {
      const f = this.record.frames[0];
      this.group.position.set(f.x, f.y, f.z);
    }
    this.group.visible = true;
  }

  /** Pause playback but keep the mesh in-scene at its last position. */
  stop(): void {
    this.playing = false;
    this.group.visible = false;
  }

  /** Advance playback by dt seconds. Safe to call when not playing. */
  update(dt: number): void {
    if (!this.playing) return;
    this.runTime += dt;
    const frames = this.record.frames;
    if (frames.length === 0) return;

    const runTimeMs = this.runTime * 1000;
    const lastFrame = frames[frames.length - 1];

    if (runTimeMs >= lastFrame.t) {
      // Clamp to the final frame — player has outlasted the ghost.
      this.group.position.set(lastFrame.x, lastFrame.y, lastFrame.z);
      if (!this.finished) {
        this.finished = true;
      }
      // Fade the ghost out softly so it doesn't hang as a static blob.
      const fadeIn = Math.max(0, 1 - (runTimeMs - lastFrame.t) / 1500);
      this.bodyMaterial.opacity = GHOST_OPACITY * fadeIn;
      if (fadeIn <= 0) this.group.visible = false;
      return;
    }

    // Walk forward from the cached index; the run time is monotonic so this is
    // typically a 0-or-1 step linear search.
    let i = this.lastFrameIdx;
    while (i < frames.length - 2 && frames[i + 1].t <= runTimeMs) i++;
    this.lastFrameIdx = i;

    const a: GhostFrame = frames[i];
    const b: GhostFrame = frames[i + 1];
    const span = b.t - a.t || 1;
    const tt = Math.min(1, Math.max(0, (runTimeMs - a.t) / span));
    const x = a.x + (b.x - a.x) * tt;
    const y = a.y + (b.y - a.y) * tt;
    const z = a.z + (b.z - a.z) * tt;
    this.group.position.set(x, y, z);

    // Gentle spin for a "not-quite-solid" feel.
    this.group.rotation.y += dt * 1.2;
  }

  /** True once the player has outrun the recording's duration. */
  isFinished(): boolean {
    return this.finished;
  }

  /** Final height recorded — useful for the challenge HUD / game-over screen. */
  get ghostHeight(): number {
    return this.record.height;
  }

  get ghostName(): string {
    return this.record.name;
  }

  get ghostDurationMs(): number {
    return this.record.durationMs;
  }

  /** Tear down and remove from scene. Call on run-restart / return-to-title. */
  dispose(): void {
    this.stop();
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) {
          for (const m of mat) m.dispose();
        } else {
          mat.dispose();
        }
      }
    });
  }
}

/**
 * Fetch `public/ghost-challenge.json`. Returns null if absent or malformed —
 * callers should fall back to a normal run.
 */
export async function loadGhostChallenge(url = "ghost-challenge.json"): Promise<GhostRecord | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) {
      if (res.status === 404) {
        console.info("[ghost-playback] No ghost available yet — the pool is still empty.");
      } else {
        console.warn(`[ghost-playback] ghost-challenge.json fetch failed: ${res.status}`);
      }
      return null;
    }
    const data = (await res.json()) as GhostRecord;
    if (!data || !Array.isArray(data.frames) || data.frames.length < 2) {
      console.warn("[ghost-playback] ghost-challenge.json has no usable frames.");
      return null;
    }
    return data;
  } catch (err) {
    console.warn("[ghost-playback] Failed to load ghost-challenge.json:", err);
    return null;
  }
}
