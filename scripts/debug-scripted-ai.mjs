/**
 * Debug script — trace key events for 400 frames on a given seed.
 */

import { ClockworkClimbSimulation } from "../dist/simulation.mjs";
import { ScriptedPolicy } from "../dist/ai-ghost-scripted.mjs";

const FIXED_DT = 1 / 60;
const SEED = parseInt(process.argv[2] ?? "1");
const FRAMES = parseInt(process.argv[3] ?? "400");

const sim = new ClockworkClimbSimulation({ seed: SEED });
sim.reset();
sim.step({ moveX: 0, moveY: 0, jump: true });

const policy = new ScriptedPolicy();

let state = sim.getState();
let prevOnGround = false;
let prevActiveGear = null;
let prevHeight = 0;

console.log(`Seed ${SEED}, running ${FRAMES} frames:`);

for (let frame = 0; frame < FRAMES; frame++) {
  if (state.gameState === "gameover") { console.log(`F${frame}: GAMEOVER height=${state.heightMaxReached.toFixed(1)}`); break; }
  const p = state.player;
  const action = policy.decide(state, FIXED_DT);

  // Log interesting transitions
  const isJump = action.jump;
  const gearChanged = state.activeGearId !== prevActiveGear;
  const heightChanged = Math.abs(state.heightMaxReached - prevHeight) > 0.5;

  if (gearChanged || isJump || heightChanged || frame < 2) {
    const nearbyGears = state.gears
      .filter(g => g.id !== state.activeGearId && g.active)
      .map(g => {
        const dx = g.x - p.x, dz = g.z - p.z;
        const lat = Math.hypot(dx, dz);
        const top = g.y + g.height / 2 + 0.12 - g.crumbleFallDistance;
        const dy = top - p.y;
        return { id: g.id, lat: lat.toFixed(2), dy: dy.toFixed(2), r: g.radius.toFixed(2) };
      })
      .filter(g => parseFloat(g.lat) < 6)
      .sort((a, b) => parseFloat(a.lat) - parseFloat(b.lat))
      .slice(0, 3);

    console.log(
      `F${frame}: y=${p.y.toFixed(2)} vy=${p.vy.toFixed(1)} onGnd=${p.onGround} gear=${state.activeGearId} ` +
      `height=${state.heightMaxReached.toFixed(1)} | mx=${action.moveX.toFixed(2)} my=${action.moveY.toFixed(2)} jump=${action.jump} ` +
      `| nearby:${nearbyGears.map(g => `${g.id}(lat=${g.lat},dy=${g.dy},r=${g.r})`).join(' ')}`
    );
  }

  prevOnGround = p.onGround;
  prevActiveGear = state.activeGearId;
  prevHeight = state.heightMaxReached;

  const result = sim.step(action);
  state = result.state;
}
console.log(`\nFinal: heightMaxReached=${state.heightMaxReached.toFixed(2)}, gameState=${state.gameState}`);
