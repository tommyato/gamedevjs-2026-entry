// src/ai-ghost-scripted.ts
var JUMP_REACH = 4;
var LATERAL_REACH = 5;
var TARGET_RESELECT_INTERVAL = 0.5;
var SCORE_HEIGHT = 1;
var SCORE_BOUNCY = 2.5;
var SCORE_NORMAL = 0.3;
var SCORE_LATERAL = 0.15;
var JUMP_THRESHOLD = LATERAL_REACH * 0.9;
var PLAYER_RADIUS = 0.3;
var PLAYER_MOVE_SPEED = 5;
var JUMP_VELOCITY = 12;
var GRAVITY = 20;
var CEILING_CLEARANCE_BUFFER = 0.2;
var DOUBLE_JUMP_VY_TRIGGER = -3;
var FALLING_VY_THRESHOLD = -0.5;
var DEBUG_SCRIPTED_AI = false;
function gearTopY(gear) {
  const pistonOffset = gear.variant === "piston" ? Math.sin(gear.pistonTime / 1.5 * Math.PI * 2) * 0.15 : 0;
  return gear.y + gear.height / 2 + 0.12 - gear.crumbleFallDistance + pistonOffset;
}
function isLandable(gear) {
  if (!gear.active) return false;
  if (gear.variant === "crumbling" && gear.crumbleArmed) return false;
  return true;
}
function isReachable(player, gear) {
  if (!isLandable(gear)) return false;
  const dx = gear.x - player.x;
  const dz = gear.z - player.z;
  const dy = gearTopY(gear) - player.y;
  const lateralDist = Math.hypot(dx, dz);
  return lateralDist <= LATERAL_REACH && dy <= JUMP_REACH && dy >= -2;
}
function scoreGear(player, gear) {
  const dy = gearTopY(gear) - player.y;
  const lateralDist = Math.hypot(gear.x - player.x, gear.z - player.z);
  let score = dy * SCORE_HEIGHT;
  if (gear.variant === "bouncy") score += SCORE_BOUNCY;
  if (gear.variant === "normal") score += SCORE_NORMAL;
  score -= lateralDist * SCORE_LATERAL;
  return score;
}
function safeJumpLateral(playerY, gear) {
  const gearBotY = gearTopY(gear) - gear.height - 0.12;
  const dyToGearBottom = gearBotY - playerY;
  if (dyToGearBottom <= 0) {
    return 0;
  }
  const disc = JUMP_VELOCITY * JUMP_VELOCITY - 2 * GRAVITY * dyToGearBottom;
  if (disc < 0) {
    return 0;
  }
  const tToExit = (JUMP_VELOCITY - Math.sqrt(disc)) / GRAVITY;
  const minLat = gear.radius + PLAYER_RADIUS + PLAYER_MOVE_SPEED * tToExit + CEILING_CLEARANCE_BUFFER;
  return Math.min(minLat, JUMP_THRESHOLD - 0.3);
}
function worldToAction(worldDX, worldDZ, orbitAngle) {
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
var ScriptedPolicy = class {
  targetId = null;
  reelectTimer = 0;
  prevActiveGearId = null;
  reset() {
    this.targetId = null;
    this.reelectTimer = 0;
    this.prevActiveGearId = null;
  }
  /**
   * Decide the next action from the full sim state.
   * Called every frame (~60 Hz).
   */
  decide(state, dt) {
    this.reelectTimer -= dt;
    const { player, gears, activeGearId, orbitAngle } = state;
    if (activeGearId !== this.prevActiveGearId) {
      this.reelectTimer = 0;
    }
    this.prevActiveGearId = activeGearId;
    const isFalling = !player.onGround && player.vy < FALLING_VY_THRESHOLD;
    let target = null;
    if (isFalling) {
      target = this.selectFallTarget(player, gears, activeGearId);
      this.targetId = target?.id ?? null;
    } else {
      const cachedTarget = this.targetId !== null ? gears.find((g) => g.id === this.targetId) ?? null : null;
      const needsReelect = !cachedTarget || !isLandable(cachedTarget) || this.reelectTimer <= 0 || !isReachable(player, cachedTarget);
      if (needsReelect) {
        target = this.selectRiseTarget(player, gears, activeGearId);
        this.targetId = target?.id ?? null;
        this.reelectTimer = TARGET_RESELECT_INTERVAL;
      } else {
        target = cachedTarget;
      }
    }
    if (!target) {
      return { moveX: 0, moveY: 0, jump: false };
    }
    const { moveX, moveY } = worldToAction(
      target.x - player.x,
      target.z - player.z,
      orbitAngle
    );
    const topY = gearTopY(target);
    const dy = topY - player.y;
    const lateralDist = Math.hypot(target.x - player.x, target.z - player.z);
    let jump = false;
    let moveXFinal = moveX;
    let moveYFinal = moveY;
    if (player.onGround) {
      if (dy > 0.1 && dy <= JUMP_REACH) {
        const minLat = safeJumpLateral(player.y, target);
        if (lateralDist > minLat && lateralDist <= JUMP_THRESHOLD) {
          jump = true;
        } else if (lateralDist <= minLat) {
          moveXFinal = -moveX;
          moveYFinal = -moveY;
        }
      }
    } else if (player.doubleJumpCharges > 0 && player.vy < DOUBLE_JUMP_VY_TRIGGER && dy > 0) {
      jump = true;
    }
    if (DEBUG_SCRIPTED_AI) {
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
  selectFallTarget(player, gears, activeGearId) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const gear of gears) {
      if (gear.id === activeGearId) continue;
      if (!isLandable(gear)) continue;
      const dy = gearTopY(gear) - player.y;
      if (dy > 0) continue;
      const lateralDist = Math.hypot(gear.x - player.x, gear.z - player.z);
      if (lateralDist < nearestDist) {
        nearestDist = lateralDist;
        nearest = gear;
      }
    }
    if (nearest) return nearest;
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
  selectRiseTarget(player, gears, activeGearId) {
    let bestAbove = null;
    let bestScore = -Infinity;
    for (const gear of gears) {
      if (gear.id === activeGearId) continue;
      if (!isLandable(gear)) continue;
      const dx = gear.x - player.x;
      const dz = gear.z - player.z;
      const lateralDist = Math.hypot(dx, dz);
      const dy = gearTopY(gear) - player.y;
      if (lateralDist > LATERAL_REACH || dy > JUMP_REACH || dy < -2) continue;
      if (dy <= 0) continue;
      const score = scoreGear(player, gear);
      if (score > bestScore) {
        bestScore = score;
        bestAbove = gear;
      }
    }
    if (bestAbove) return bestAbove;
    return this.selectFallTarget(player, gears, activeGearId);
  }
};
export {
  ScriptedPolicy
};
