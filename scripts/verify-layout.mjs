import { ClockworkClimbSimulation } from "../dist/simulation.mjs";

const SEED_COUNT = 250;
const TARGET_HEIGHT = 160;
const OVERLAP_VERTICAL_WINDOW = 1.1;
const STACKED_VERTICAL_WINDOW = 3.1;

function collectIssues(gears) {
  const issues = [];

  for (let index = 0; index < gears.length; index += 1) {
    const gear = gears[index];

    if (index > 0) {
      const hasReachablePrior = gears.slice(0, index).some((prior) => {
        const verticalDistance = gear.y - prior.y;
        if (verticalDistance < 0.35 || verticalDistance > 4.1) {
          return false;
        }
        const horizontalDistance = Math.hypot(gear.x - prior.x, gear.z - prior.z);
        const playableGap = horizontalDistance - gear.radius - prior.radius;
        return horizontalDistance >= 1.0 && playableGap <= 2.9;
      });

      if (!hasReachablePrior) {
        issues.push({
          type: "unreachable",
          message: `gear ${gear.id} at y=${gear.y.toFixed(2)} has no reachable prior anchor`,
        });
        if (issues.length >= 8) {
          return issues;
        }
      }
    }

    for (let compareIndex = index + 1; compareIndex < gears.length; compareIndex += 1) {
      const other = gears[compareIndex];
      const horizontalDistance = Math.hypot(gear.x - other.x, gear.z - other.z);
      const verticalDistance = Math.abs(gear.y - other.y);
      const edgeGap = horizontalDistance - gear.radius - other.radius;
      const stackedThreshold = Math.max(0.95, Math.min(gear.radius, other.radius) * 0.65);

      if (verticalDistance < OVERLAP_VERTICAL_WINDOW && edgeGap < -0.05) {
        issues.push({
          type: "overlap",
          message: `gears ${gear.id}/${other.id} overlap at dy=${verticalDistance.toFixed(2)} gap=${edgeGap.toFixed(2)}`,
        });
      } else if (verticalDistance < STACKED_VERTICAL_WINDOW && horizontalDistance < stackedThreshold) {
        issues.push({
          type: "stacked",
          message: `gears ${gear.id}/${other.id} stack at dy=${verticalDistance.toFixed(2)} d=${horizontalDistance.toFixed(2)}`,
        });
      }

      if (issues.length >= 8) {
        return issues;
      }
    }
  }

  return issues;
}

const failures = [];
let maxGearCount = 0;

for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
  const sim = new ClockworkClimbSimulation({ seed });
  sim.reset();
  const state = sim.debugGenerateLayoutToHeight(TARGET_HEIGHT);
  const issues = collectIssues(state.gears);
  maxGearCount = Math.max(maxGearCount, state.gears.length);

  if (issues.length > 0) {
    failures.push({
      seed,
      issues,
    });
  }
}

if (failures.length > 0) {
  console.error(`layout verification failed for ${failures.length} / ${SEED_COUNT} seeds`);
  for (const failure of failures.slice(0, 8)) {
    console.error(`seed ${failure.seed}`);
    for (const issue of failure.issues) {
      console.error(`  - ${issue.type}: ${issue.message}`);
    }
  }
  process.exit(1);
}

console.log(`layout verification passed for ${SEED_COUNT} seeds up to ${TARGET_HEIGHT}m (max gears ${maxGearCount})`);
