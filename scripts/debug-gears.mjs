/**
 * Show all gears within lateral reach from a specific position and height.
 */

import { ClockworkClimbSimulation } from "../dist/simulation.mjs";
import { ScriptedPolicy } from "../dist/ai-ghost-scripted.mjs";

const FIXED_DT = 1 / 60;
const SEED = parseInt(process.argv[2] ?? "1");

const sim = new ClockworkClimbSimulation({ seed: SEED });
sim.reset();
sim.step({ moveX: 0, moveY: 0, jump: true });

const policy = new ScriptedPolicy();

// Step to gear 1 landing
let state = sim.getState();
let targetFrame = 100; // should be landed on gear 1 by frame 100
for (let frame = 0; frame < targetFrame; frame++) {
  if (state.gameState === "gameover") break;
  const action = policy.decide(state, FIXED_DT);
  state = sim.step(action).state;
}

const p = state.player;
console.log(`At frame ${targetFrame}: y=${p.y.toFixed(2)} onGnd=${p.onGround} activeGear=${state.activeGearId} height=${state.heightMaxReached.toFixed(1)}`);
console.log(`\nAll gears sorted by dy (relative to player y=${p.y.toFixed(2)}):`);

const gearInfo = state.gears
  .filter(g => g.active)
  .map(g => {
    const dx = g.x - p.x, dz = g.z - p.z;
    const lat = Math.hypot(dx, dz);
    const top = g.y + g.height / 2 + 0.12 - g.crumbleFallDistance;
    const dy = top - p.y;
    return { id: g.id, lat: lat.toFixed(2), dy: dy.toFixed(2), r: g.radius.toFixed(2), variant: g.variant };
  })
  .sort((a, b) => parseFloat(a.dy) - parseFloat(b.dy))
  .filter(g => parseFloat(g.dy) > -5 && parseFloat(g.lat) < 20); // show gears in range

gearInfo.forEach(g => {
  const reachable = parseFloat(g.lat) <= 5.0 && parseFloat(g.dy) <= 4.0 && parseFloat(g.dy) >= -2;
  const tag = reachable ? ' *** REACHABLE ***' : '';
  console.log(`  gear ${g.id}: lat=${g.lat} dy=${g.dy} r=${g.r} variant=${g.variant}${tag}`);
});
