#!/usr/bin/env node
/**
 * Regression guard for the cancel-in-progress orbit glide on directional input.
 *
 * Build #49 added an idle-gate that stops the camera from re-targeting while
 * the player is steering. Build #51 adds the complementary cancel: if the
 * camera is already gliding when directional input resumes, snap orbitAngleTarget
 * to the current orbitAngle so the glide freezes immediately.
 *
 * Run: npm run verify:orbit-cancel
 */
import { ClockworkClimbSimulation } from "../dist/simulation.mjs";

const FIXED_DT = 1 / 60;
const ORBIT_IDLE_THRESHOLD = 0.4;

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed++;
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failed++;
  }
}

// Number of idle frames needed to exceed ORBIT_IDLE_THRESHOLD
const idleFrames = Math.ceil(ORBIT_IDLE_THRESHOLD / FIXED_DT) + 2;

// ── Cases 1 + 2: shared simulation instance ───────────────────────────────────

const sim12 = /** @type {any} */ (new ClockworkClimbSimulation({ seed: 42 }));
sim12.reset();

// Build up inputIdleSeconds past the threshold
for (let i = 0; i < idleFrames; i++) {
  sim12.step({ moveX: 0, moveY: 0, jump: false });
}

// Force an in-progress glide: set the target 1 rad ahead of current angle
const preCancelAngle = sim12.state.orbitAngle;
sim12.orbitAngleTarget = preCancelAngle + 1.0;
sim12.wasInputIdle = true; // mark as currently idle so the cancel will fire

// ── Case 1: Glide cancels on resumed directional input ────────────────────────
{
  const result = sim12.step({ moveX: 1, moveY: 0, jump: false });
  assert(
    Math.abs(result.state.orbitAngle - preCancelAngle) < 0.001,
    "case 1: glide cancels on resume — orbitAngle must not advance toward stale target"
  );
}

// ── Case 2: Idle re-orbit re-engages after cancel ─────────────────────────────
{
  // Force the camera to angle 0 so re-engagement is clearly detectable.
  // Player is near (0, 2, 2), so auto-orbit will target ≈ PI/2 once idle.
  sim12.state.orbitAngle = 0;
  sim12.orbitAngleTarget = 0;

  let lastResult;
  const reIdleFrames = Math.ceil(0.6 / FIXED_DT);
  for (let i = 0; i < reIdleFrames; i++) {
    lastResult = sim12.step({ moveX: 0, moveY: 0, jump: false });
  }

  assert(
    Math.abs(lastResult.state.orbitAngle) > 0.01,
    "case 2: idle re-orbit re-engages — orbitAngle must move away from 0 after ≥ 0.4s idle"
  );
}

// ── Case 3: Jump-only input does NOT cancel the orbit ─────────────────────────
{
  const sim = /** @type {any} */ (new ClockworkClimbSimulation({ seed: 42 }));
  sim.reset();

  for (let i = 0; i < idleFrames; i++) {
    sim.step({ moveX: 0, moveY: 0, jump: false });
  }

  sim.orbitAngleTarget = sim.state.orbitAngle + 1.0;
  sim.wasInputIdle = true;

  // Jump-only: moveX/moveY both 0 → inputIdleSeconds keeps growing → inputIdle stays true
  sim.step({ moveX: 0, moveY: 0, jump: true });

  // wasInputIdle should still be true (cancel did not fire)
  assert(
    sim.wasInputIdle === true,
    "case 3: jump-only does not cancel — wasInputIdle must remain true after jump"
  );
}

// ── Case 4: No-op when orbitAngleTarget already equals orbitAngle ─────────────
{
  const sim = /** @type {any} */ (new ClockworkClimbSimulation({ seed: 42 }));
  sim.reset();

  // orbitAngleTarget == orbitAngle == PI/2 by default after reset.
  // Force wasInputIdle=true so the cancel path is exercised (as a no-op).
  sim.wasInputIdle = true;

  const result = sim.step({ moveX: 1, moveY: 0, jump: false });

  assert(
    !isNaN(result.state.orbitAngle) && isFinite(result.state.orbitAngle),
    "case 4: no-op when target==angle — orbitAngle must be a finite number"
  );
  assert(
    Math.abs(result.state.orbitAngle - Math.PI / 2) < 0.01,
    "case 4: no-op when target==angle — orbit stays put at PI/2"
  );
}

// ── Case 5: reset() clears wasInputIdle ───────────────────────────────────────
{
  const sim = /** @type {any} */ (new ClockworkClimbSimulation({ seed: 42 }));
  sim.reset();

  // Trigger the cancel path so wasInputIdle and orbitAngleTarget are non-initial
  for (let i = 0; i < idleFrames; i++) {
    sim.step({ moveX: 0, moveY: 0, jump: false });
  }
  sim.orbitAngleTarget = sim.state.orbitAngle + 1.0;
  sim.wasInputIdle = true;
  sim.step({ moveX: 1, moveY: 0, jump: false }); // fires cancel

  // Now reset — both wasInputIdle and orbitAngleTarget must return to initial values
  sim.reset();

  assert(
    sim.wasInputIdle === false,
    "case 5: reset clears wasInputIdle — must be false after reset"
  );
  assert(
    Math.abs(sim.orbitAngleTarget - Math.PI / 2) < 0.001,
    "case 5: reset restores orbitAngleTarget to PI/2"
  );
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\norbit-cancel verification FAILED: ${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\norbit-cancel verification passed: ${passed} assertions.`);
