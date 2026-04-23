/**
 * Headless sanity check for the ScriptedPolicy AI planner.
 *
 * Runs the scripted policy for 60 sim-seconds on seeds 1, 42, and 12345.
 * Asserts heightMaxReached > 15 on at least 2 of 3 seeds.
 *
 * Run: npm run verify:scripted-ai
 */

import { ClockworkClimbSimulation } from "../dist/simulation.mjs";
import { ScriptedPolicy } from "../dist/ai-ghost-scripted.mjs";

const SEEDS = [1, 42, 12345];
const SIM_SECONDS = 60;
const FIXED_DT = 1 / 60;
const FRAMES = Math.ceil(SIM_SECONDS / FIXED_DT);
const MIN_HEIGHT = 15;     // each seed must exceed this
const REQUIRED_PASSING = 2; // at least this many seeds must pass

const results = [];

for (const seed of SEEDS) {
  const sim = new ClockworkClimbSimulation({ seed });
  sim.reset();
  // Mirror AIGhost.reset(): one jump step to get the ghost moving immediately.
  sim.step({ moveX: 0, moveY: 0, jump: true });

  const policy = new ScriptedPolicy();

  let state = sim.getState();
  for (let frame = 0; frame < FRAMES; frame++) {
    if (state.gameState === "gameover") break;
    const action = policy.decide(state, FIXED_DT);
    const result = sim.step(action);
    state = result.state;
  }

  const height = state.heightMaxReached;
  const passed = height > MIN_HEIGHT;
  results.push({ seed, height, passed });
  console.log(
    `seed ${seed}: heightMaxReached=${height.toFixed(1)}m  [${passed ? "PASS" : "FAIL"}]`
  );
}

const passing = results.filter((r) => r.passed).length;
console.log(`\n${passing}/${SEEDS.length} seeds passed (need >= ${REQUIRED_PASSING})`);

if (passing < REQUIRED_PASSING) {
  console.error("FAIL: scripted AI did not reach minimum height on enough seeds.");
  process.exit(1);
}

console.log("PASS: scripted AI verification complete.");
