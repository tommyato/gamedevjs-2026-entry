/**
 * Fine-grained trace: show every frame between two frames on a seed.
 */
import { ClockworkClimbSimulation } from "../dist/simulation.mjs";
import { ScriptedPolicy } from "../dist/ai-ghost-scripted.mjs";

const FIXED_DT = 1 / 60;
const SEED = parseInt(process.argv[2] ?? "42");
const START_FRAME = parseInt(process.argv[3] ?? "100");
const END_FRAME = parseInt(process.argv[4] ?? "125");

const sim = new ClockworkClimbSimulation({ seed: SEED });
sim.reset();
sim.step({ moveX: 0, moveY: 0, jump: true });
const policy = new ScriptedPolicy();

let state = sim.getState();
for (let f = 0; f < START_FRAME; f++) {
  if (state.gameState === "gameover") break;
  const action = policy.decide(state, FIXED_DT);
  state = sim.step(action).state;
}

for (let f = START_FRAME; f < END_FRAME; f++) {
  if (state.gameState === "gameover") { console.log(`F${f}: GAMEOVER`); break; }
  const p = state.player;
  const action = policy.decide(state, FIXED_DT);

  // Find gear 1 and gear 2
  const g1 = state.gears.find(g => g.id === 1);
  const g2 = state.gears.find(g => g.id === 2);
  const lat1 = g1 ? Math.hypot(g1.x - p.x, g1.z - p.z).toFixed(2) : "?";
  const lat2 = g2 ? Math.hypot(g2.x - p.x, g2.z - p.z).toFixed(2) : "?";
  const dy2 = g2 ? ((g2.y + g2.height/2 + 0.12) - p.y).toFixed(2) : "?";

  console.log(
    `F${f}: y=${p.y.toFixed(3)} vy=${p.vy.toFixed(2)} onGnd=${p.onGround} gear=${state.activeGearId} ` +
    `mx=${action.moveX.toFixed(2)} my=${action.moveY.toFixed(2)} jmp=${action.jump} ` +
    `| lat_g1=${lat1} lat_g2=${lat2} dy_g2=${dy2}`
  );

  state = sim.step(action).state;
}
