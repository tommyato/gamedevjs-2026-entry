/**
 * GearPool — recycles Gear instances to eliminate hot-loop allocation pressure.
 *
 * Strategy: per-variant free-lists keyed by `${variant}-${Math.floor(radius * 10)}`.
 * The `Math.floor(radius * 10)` bucket identifies the tooth count
 * (`toothCount = Math.floor(radius * 10)` in the Gear constructor), so all entries
 * in a bucket share an identical mesh structure. Within a bucket the radius varies by
 * at most ±0.05 units (< 4 % of the minimum bucket radius of 1.3), producing an
 * imperceptible size difference in fast-moving gameplay — no mesh scaling is applied.
 *
 * Per-instance colour variation (colour, danger) is applied in-place via Gear.reset(),
 * which updates material colour/emissive uniforms without allocating new material objects.
 *
 * Title-backdrop gears (5 static decorations, height = 0.5) are intentionally excluded:
 * they are created infrequently, have a different height, and are parented to a
 * titleBackdropGroup rather than the scene — pooling them would add complexity for
 * negligible benefit.
 *
 * Profiling: `window.__gearAllocs` tracks the number of actual `new Gear()` constructions.
 * Free-list reuses do not increment the counter. Read it in Chrome DevTools after a
 * 3-minute solo run; target is ≤ 50.
 */

import * as THREE from "three";
import { Gear, type GearInit, type GearVariant } from "./gear";

export { type GearInit };

export class GearPool {
  // Free-lists keyed by `${variant}-${Math.floor(radius * 10)}`.
  private readonly freeLists = new Map<string, Gear[]>();
  private _allocCount = 0;

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Pops a matching free-list entry or constructs a new Gear, then adds the mesh to
   * the scene.  Calls gear.reset(opts) on a reused entry to update colours and state.
   */
  acquire(opts: GearInit): Gear {
    const variant = (opts.variant ?? "normal") as GearVariant;
    const radius = opts.radius ?? 1.5;
    const key = `${variant}-${Math.floor(radius * 10)}`;

    const list = this.freeLists.get(key);
    if (list && list.length > 0) {
      const gear = list.pop()!;
      gear.reset(opts);
      this.scene.add(gear.mesh);
      return gear;
    }

    // No free entry — construct a new instance and track the allocation.
    const gear = new Gear(opts);
    this._allocCount++;
    (window as any).__gearAllocs = this._allocCount;
    this.scene.add(gear.mesh);
    return gear;
  }

  /**
   * Removes the gear's mesh from the scene and pushes the instance onto the free-list
   * for future reuse.  Does NOT dispose geometry or materials.
   */
  release(gear: Gear): void {
    this.scene.remove(gear.mesh);
    const key = `${gear.variant}-${Math.floor(gear.radius * 10)}`;
    let list = this.freeLists.get(key);
    if (!list) {
      list = [];
      this.freeLists.set(key, list);
    }
    list.push(gear);
  }

  /**
   * Full teardown — disposes geometries and materials for all pooled entries.
   * Call only on page unload; never between runs (the pool persists across
   * restartGame() to maximise reuse savings).
   */
  disposeAll(): void {
    for (const list of this.freeLists.values()) {
      for (const gear of list) {
        gear.mesh.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) mat.dispose();
        });
      }
    }
    this.freeLists.clear();
    this._allocCount = 0;
    delete (window as any).__gearAllocs;
  }

  /** Number of actual `new Gear()` constructions; free-list reuses are not counted. */
  get allocCount(): number {
    return this._allocCount;
  }
}
