/**
 * Scripted AI planner for Clockwork Climb — replaces the RL/ONNX policy for ?_ai=1.
 *
 * Uses a greedy one-step lookahead over sim.getState() to select and navigate
 * to the highest reachable gear above the player. No model weights, no fetch.
 *
 * Activate: ?_ai=1 (default ghost). Fallbacks: ?_ai=onnx, ?_ai=mlp.
 */

import type { SimAction, SimGear, SimPlayer, SimState } from "./sim-types";

// ---------------------------------------------------------------------------
// Reachability constants — mirror simulation.ts:1597 exactly.
// Update BOTH files if jump physics change.
// ---------------------------------------------------------------------------

/** Max vertical delta (upward) the player can reach with a normal jump. */
const JUMP_REACH = 4.0;
/** Max horizontal distance the player can traverse to land on a gear. */
const LATERAL_REACH = 5.0;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Seconds between forced target re-evaluations (prevents thrashing). */
const TARGET_RESELECT_INTERVAL = 0.5;

/** Height gain score weight — primary factor. */
const SCORE_HEIGHT = 1.0;
/** Bonus for bouncy gears (1.4× jump velocity → ~7m peak vs 3.6m normal). */
const SCORE_BOUNCY = 2.5;
/** Slight preference for normal variant over others at equal height/lateral. */
const SCORE_NORMAL = 0.3;
/** Penalty per meter of lateral distance — prefer nearby gears. */
const SCORE_LATERAL = 0.15;

/**
 * Max lateral distance from which we initiate a jump toward the target.
 * 4.5m gives up to 4.25m of horizontal travel during a full arc — enough to
 * carry the player from the far edge of one gear to the top of the next even
 * when large gears require a wide launch corridor.
 */
const JUMP_THRESHOLD = LATERAL_REACH * 0.9; // 4.5m

// ---------------------------------------------------------------------------
// Physics constants — mirror simulation.ts exactly.
// Update BOTH files if any of these change.
// ---------------------------------------------------------------------------

/** Player collider radius (simulation.ts PLAYER_RADIUS). */
const PLAYER_RADIUS = 0.3;
/** Player body height (simulation.ts — used in ceiling-block check). */
const PLAYER_HEIGHT = 0.6;
/** Horizontal run speed (simulation.ts PLAYER_MOVE_SPEED). */
const PLAYER_MOVE_SPEED = 5.0;
/** Vertical velocity on jump (simulation.ts JUMP_VELOCITY). */
const JUMP_VELOCITY = 12.0;
/** Downward acceleration (simulation.ts GRAVITY). */
const GRAVITY = 20.0;

/**
 * Extra clearance (m) added to the computed safe launch distance.
 *
 * simulation.ts:checkBlockFromBelow fires from the moment the rising player's
 * head (y + PLAYER_HEIGHT) first enters a gear's bottom until the player's
 * FEET (y) clear the gear bottom.  The safe launch distance must account for
 * ALL horizontal travel during this entire window, i.e. up to t_exit (when
 * player.y = gearBotY, computed in safeJumpLateral).  This buffer is the
 * remaining safety margin: at t_exit the lateral distance will be exactly
 * (gear.radius + PLAYER_RADIUS + CEILING_CLEARANCE_BUFFER), so the margin
 * equals this constant.  0.2 m is sufficient given 60 Hz physics steps.
 */
const CEILING_CLEARANCE_BUFFER = 0.2;

/** Fire double-jump when vy drops below this value (m/s). */
const DOUBLE_JUMP_VY_TRIGGER = -3.0;

/**
 * vy threshold below which the player is considered "falling".
 * Used to switch from greedy-above targeting to fall-guidance targeting.
 * A small negative value absorbs the 1-frame gravity step after landing.
 */
const FALLING_VY_THRESHOLD = -0.5;

/** Set to true temporarily for debugging — false before commit. */
const DEBUG_SCRIPTED_AI = false;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Effective top-surface Y of a gear.
 * Mirrors the private getGearTopY() in simulation.ts.
 */
function gearTopY(gear: SimGear): number {
  const pistonOffset =
    gear.variant === "piston"
      ? Math.sin((gear.pistonTime / 1.5) * Math.PI * 2) * 0.15
      : 0;
  return gear.y + gear.height / 2 + 0.12 - gear.crumbleFallDistance + pistonOffset;
}

/**
 * Whether this gear is safe to target for landing.
 * Excludes crumble-armed gears, mirroring simulation.ts:isPlayerStranded.
 */
function isLandable(gear: SimGear): boolean {
  if (!gear.active) return false;
  if (gear.variant === "crumbling" && gear.crumbleArmed) return false;
  return true;
}

/**
 * Whether the target gear is reachable from the player's current position.
 * Uses the exact same constants as simulation.ts:1597.
 */
function isReachable(player: SimPlayer, gear: SimGear): boolean {
  if (!isLandable(gear)) return false;
  const dx = gear.x - player.x;
  const dz = gear.z - player.z;
  const dy = gearTopY(gear) - player.y;
  const lateralDist = Math.hypot(dx, dz);
  return lateralDist <= LATERAL_REACH && dy <= JUMP_REACH && dy >= -2;
}

/**
 * Score a candidate gear. Higher = better target.
 */
function scoreGear(player: SimPlayer, gear: SimGear): number {
  const dy = gearTopY(gear) - player.y;
  const lateralDist = Math.hypot(gear.x - player.x, gear.z - player.z);
  let score = dy * SCORE_HEIGHT;
  if (gear.variant === "bouncy") score += SCORE_BOUNCY;
  if (gear.variant === "normal") score += SCORE_NORMAL;
  score -= lateralDist * SCORE_LATERAL;
  return score;
}

/**
 * Minimum lateral launch distance from which the player can jump toward this
 * gear without triggering checkBlockFromBelow (simulation.ts).
 *
 * checkBlockFromBelow fires while the player is ASCENDING and their body
 * spans the gear's bottom face: player.y < gearBotY AND player.y+PLAYER_HEIGHT >
 * gearBotY.  This zone is active from t_entry (head first touches gear bottom)
 * to t_exit (feet clear gear bottom, player.y = gearBotY).
 *
 * We use t_exit — the worst case — because the player drifts laterally closer
 * to the target the entire time they're in the zone.  The safe minimum launch
 * lateral is: (gear.radius + PLAYER_RADIUS) + PLAYER_MOVE_SPEED * t_exit + buffer.
 *
 * Returns a value capped at (JUMP_THRESHOLD − 0.3) so the sweet-spot
 * [minLat, JUMP_THRESHOLD] always has positive width.
 */
function safeJumpLateral(playerY: number, gear: SimGear): number {
  // Physical bottom face of the gear disc.
  // gearTopY = gear.y + gear.height/2 + 0.12, so gearBotY = gearTopY − height − 0.12.
  const gearBotY = gearTopY(gear) - gear.height - 0.12;
  // Height rise needed for player's FEET to clear the gear bottom (t_exit).
  const dyToGearBottom = gearBotY - playerY;
  if (dyToGearBottom <= 0) {
    // Player's feet already above gear bottom — ceiling block impossible.
    return 0;
  }
  const disc = JUMP_VELOCITY * JUMP_VELOCITY - 2 * GRAVITY * dyToGearBottom;
  if (disc < 0) {
    // Jump can't reach gear bottom (very high gear slipped past dy filter).
    return 0;
  }
  const tToExit = (JUMP_VELOCITY - Math.sqrt(disc)) / GRAVITY;
  const minLat =
    gear.radius + PLAYER_RADIUS + PLAYER_MOVE_SPEED * tToExit + CEILING_CLEARANCE_BUFFER;
  // Ensure the sweet-spot [minLat, JUMP_THRESHOLD] always has positive width.
  return Math.min(minLat, JUMP_THRESHOLD - 0.3);
}

/**
 * Convert a world-space (dx, dz) displacement into the action frame.
 *
 * Inverse of advancePlayer's camera-relative → world rotation (simulation.ts:1189):
 *   worldX = moveX * cosYaw - moveY * sinYaw
 *   worldZ = moveX * sinYaw + moveY * cosYaw
 *
 * Transpose (orthonormal rotation matrix inverse):
 *   moveX = worldX * cosYaw + worldZ * sinYaw
 *   moveY = -worldX * sinYaw + worldZ * cosYaw
 */
function worldToAction(
  worldDX: number,
  worldDZ: number,
  orbitAngle: number
): { moveX: number; moveY: number } {
  const cameraYaw = orbitAngle - Math.PI / 2;
  const sinYaw = Math.sin(cameraYaw);
  const cosYaw = Math.cos(cameraYaw);
  const moveX = worldDX * cosYaw + worldDZ * sinYaw;
  const moveY = -worldDX * sinYaw + worldDZ * cosYaw;
  const len = Math.hypot(moveX, moveY);
  if (len > 1e-6) {
    return { moveX: moveX / len, moveY: moveY / len };
  }
  return { moveX: 0, moveY: 0 };
}

// ---------------------------------------------------------------------------
// ScriptedPolicy
// ---------------------------------------------------------------------------

export class ScriptedPolicy {
  private targetId: number | null = null;
  private reelectTimer = 0;
  private prevActiveGearId: number | null = null;

  reset(): void {
    this.targetId = null;
    this.reelectTimer = 0;
    this.prevActiveGearId = null;
  }

  /**
   * Decide the next action from the full sim state.
   * Called every frame (~60 Hz).
   */
  decide(state: SimState, dt: number): SimAction {
    this.reelectTimer -= dt;
    const { player, gears, activeGearId, orbitAngle } = state;

    // Landing on a new gear triggers immediate target re-evaluation.
    if (activeGearId !== this.prevActiveGearId) {
      this.reelectTimer = 0;
    }
    this.prevActiveGearId = activeGearId;

    // -----------------------------------------------------------------------
    // Target selection
    //
    // Two modes depending on whether the player is falling:
    //
    //   FALLING (vy < FALLING_VY_THRESHOLD):
    //     Guide toward the nearest gear at or below the player's height.
    //     This handles the initial drop-onto-first-gear and post-overshoot
    //     corrections. The player was launched (or started) in the air and
    //     needs to land before strategic jumping begins.
    //
    //   GROUNDED or RISING:
    //     Greedy highest-score gear above the player. Re-elect on timer or
    //     when the cached target becomes invalid.
    // -----------------------------------------------------------------------
    const isFalling = !player.onGround && player.vy < FALLING_VY_THRESHOLD;
    let target: SimGear | null = null;

    if (isFalling) {
      // Re-evaluate every frame while falling to track the nearest landing spot.
      target = this.selectFallTarget(player, gears, activeGearId);
      this.targetId = target?.id ?? null;
    } else {
      const cachedTarget =
        this.targetId !== null ? gears.find((g) => g.id === this.targetId) ?? null : null;
      const needsReelect =
        !cachedTarget ||
        !isLandable(cachedTarget) ||
        this.reelectTimer <= 0 ||
        !isReachable(player, cachedTarget);
      if (needsReelect) {
        target = this.selectRiseTarget(player, gears, activeGearId);
        this.targetId = target?.id ?? null;
        this.reelectTimer = TARGET_RESELECT_INTERVAL;
      } else {
        target = cachedTarget;
      }
    }

    if (!target) {
      // No landable gear found — hold position; rescue spawn is imminent.
      return { moveX: 0, moveY: 0, jump: false };
    }

    // Direction toward the target in action (camera-relative) space.
    const { moveX, moveY } = worldToAction(
      target.x - player.x,
      target.z - player.z,
      orbitAngle
    );

    const topY = gearTopY(target);
    const dy = topY - player.y;
    const lateralDist = Math.hypot(target.x - player.x, target.z - player.z);

    // -----------------------------------------------------------------------
    // Jump decision — with dynamic ceiling-clearance.
    //
    // checkBlockFromBelow (simulation.ts) fires while the player is rising
    // through a gear's bottom face within (gear.radius + PLAYER_RADIUS)
    // laterally.  After a block, resolveGrounding skips that gear because
    // prevY < gearBottom − 0.05 — so we must be OUTSIDE the danger zone by
    // the time our head reaches the gear bottom.  safeJumpLateral() computes
    // the minimum lateral launch distance accounting for horizontal travel at
    // PLAYER_MOVE_SPEED during the upward arc.
    // -----------------------------------------------------------------------
    let jump = false;
    let moveXFinal = moveX;
    let moveYFinal = moveY;

    if (player.onGround) {
      if (dy > 0.1 && dy <= JUMP_REACH) {
        const minLat = safeJumpLateral(player.y, target);
        if (lateralDist > minLat && lateralDist <= JUMP_THRESHOLD) {
          // Sweet spot: outside ceiling-block travel zone, within jump threshold.
          jump = true;
        } else if (lateralDist <= minLat) {
          // Too close for a safe jump.  Move toward the far side of the active gear
          // (direction: target → activeGear center) so the player traverses the gear
          // and reaches a lateral distance > minLat before jumping.  This avoids the
          // failure mode of reversing toward the gear's near edge and walking off.
          const activeGear =
            activeGearId !== null ? gears.find((g) => g.id === activeGearId) ?? null : null;
          if (activeGear) {
            const { moveX: mx, moveY: my } = worldToAction(
              activeGear.x - target.x,
              activeGear.z - target.z,
              orbitAngle
            );
            moveXFinal = mx;
            moveYFinal = my;
          } else {
            // No active gear — fall back to direct reverse.
            moveXFinal = -moveX;
            moveYFinal = -moveY;
          }
        }
        // else lateralDist > JUMP_THRESHOLD: keep approaching (default toward target).
      }
    } else if (
      player.doubleJumpCharges > 0 &&
      player.vy < DOUBLE_JUMP_VY_TRIGGER &&
      dy > 0
    ) {
      // Falling with double-jump charges; target still above — fire one.
      jump = true;
    }

    if (DEBUG_SCRIPTED_AI) {
      // console.log(`[scripted] id=${target.id}(${target.variant}) dy=${dy.toFixed(2)} lat=${lateralDist.toFixed(2)} jump=${jump} onGnd=${player.onGround} vy=${player.vy.toFixed(1)} ceilZone=${(target.radius + PLAYER_RADIUS + CEILING_CLEARANCE_BUFFER).toFixed(2)}`);
    }

    return { moveX: moveXFinal, moveY: moveYFinal, jump };
  }

  // ---------------------------------------------------------------------------
  // Target selection helpers
  // ---------------------------------------------------------------------------

  /**
   * Fall-guidance targeting: nearest landable gear at or below the player's height.
   *
   * When the player is falling (initial drop or post-overshoot), we want them
   * to land on the closest thing below them rather than drift away chasing a
   * high gear that requires a jump they can't take.
   */
  private selectFallTarget(
    player: SimPlayer,
    gears: SimGear[],
    activeGearId: number | null
  ): SimGear | null {
    let nearest: SimGear | null = null;
    let nearestDist = Infinity;

    // Primary: nearest gear that is at or below the player (can land on it while falling).
    for (const gear of gears) {
      if (gear.id === activeGearId) continue;
      if (!isLandable(gear)) continue;
      const dy = gearTopY(gear) - player.y;
      if (dy > 0) continue; // above us — skip
      const lateralDist = Math.hypot(gear.x - player.x, gear.z - player.z);
      if (lateralDist < nearestDist) {
        nearestDist = lateralDist;
        nearest = gear;
      }
    }

    if (nearest) return nearest;

    // Fallback: nearest gear at any height (player somehow below all gears — rare).
    nearestDist = Infinity;
    for (const gear of gears) {
      if (gear.id === activeGearId) continue;
      if (!isLandable(gear)) continue;
      const lateralDist = Math.hypot(gear.x - player.x, gear.z - player.z);
      if (lateralDist < nearestDist) {
        nearestDist = lateralDist;
        nearest = gear;
      }
    }
    return nearest;
  }

  /**
   * Rise/ground targeting: greedy highest-score reachable gear above the player.
   * Falls back to selectFallTarget if nothing is above.
   */
  private selectRiseTarget(
    player: SimPlayer,
    gears: SimGear[],
    activeGearId: number | null
  ): SimGear | null {
    let bestAbove: SimGear | null = null;
    let bestScore = -Infinity;

    for (const gear of gears) {
      if (gear.id === activeGearId) continue;
      if (!isLandable(gear)) continue;

      const dx = gear.x - player.x;
      const dz = gear.z - player.z;
      const lateralDist = Math.hypot(dx, dz);
      const dy = gearTopY(gear) - player.y;

      // Must be within the reachability cone and above the player.
      if (lateralDist > LATERAL_REACH || dy > JUMP_REACH || dy < -2) continue;
      if (dy <= 0) continue;

      const score = scoreGear(player, gear);
      if (score > bestScore) {
        bestScore = score;
        bestAbove = gear;
      }
    }

    if (bestAbove) return bestAbove;

    // Fallback: nearest landable gear at any height (survival).
    return this.selectFallTarget(player, gears, activeGearId);
  }
}
