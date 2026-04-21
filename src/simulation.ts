import type { GearVariant, SimAction, SimBolt, SimEvent, SimGear, SimPlayer, SimPowerUp, SimState } from "./sim-types";

type DifficultyBand = {
  danger: number;
  distanceMax: number;
  distanceMin: number;
  radiusMax: number;
  radiusMin: number;
  rotationMax: number;
  rotationMin: number;
  verticalMax: number;
  verticalMin: number;
};

type SimulationConfig = {
  seed?: number;
  fixedDt?: number;
};

type LandingResult = {
  onGear: boolean;
  y: number;
  momentumX: number;
  momentumZ: number;
};

type BlockResult = {
  blocked: boolean;
  capY: number;
};

const DEFAULT_FIXED_DT = 1 / 60;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 0.6;
const PLAYER_MOVE_SPEED = 5;
const JUMP_VELOCITY = 12;
const PISTON_LAUNCH_VELOCITY = 18;
const GRAVITY = 20;
const ORBIT_RADIUS = 12;
const COMBO_WINDOW = 2.5;
const BOLT_SCORE_VALUE = 5;

export class ClockworkClimbSimulation {
  private static readonly DISCRETE_ACTIONS: SimAction[] = [
    { moveX: 0, moveY: 0, jump: false },    // 0: idle
    { moveX: -1, moveY: 0, jump: false },   // 1: left
    { moveX: 1, moveY: 0, jump: false },    // 2: right
    { moveX: 0, moveY: 1, jump: false },    // 3: forward
    { moveX: 0, moveY: 0, jump: true },     // 4: jump
    { moveX: -1, moveY: 0, jump: true },    // 5: left + jump
    { moveX: 1, moveY: 0, jump: true },     // 6: right + jump
    { moveX: 0, moveY: 1, jump: true },     // 7: forward + jump
  ];

  private readonly initialSeed: number;
  private readonly fixedDt: number | null;

  private rng: () => number;
  private state: SimState;
  private events: SimEvent[] = [];
  private gearIdCounter = 0;
  private boltIdCounter = 0;
  private powerUpIdCounter = 0;
  private generationHeight = 0;
  private generationAngle = 0;
  private cleanupTimer = 0;
  private timeSinceLastLanding = Infinity;
  private readonly recentComboGearIds = new Set<number>();
  private readonly unlockedThisRun = new Set<string>();
  private orbitAngleTarget = Math.PI / 2;
  private cameraY = 8.1;
  private deathFreezeTimer = 0;
  private nextChallengeZoneHeight = 100;
  private challengeZoneEntryScore = 0;
  private windGearCount = 0;
  private bouncyGearCount = 0;
  private powerUpCount = 0;
  private completedChallengeZones = 0;
  private shieldSaveCount = 0;
  private airBoltChain = 0;
  private bestAirBoltChain = 0;
  private consecutiveCrumble = 0;
  private nextMilestoneGearHeight = 25;

  constructor(config: SimulationConfig = {}) {
    this.initialSeed = Number.isFinite(config.seed) ? Number(config.seed) : Math.floor(Math.random() * 0x1_0000_0000);
    this.fixedDt = Number.isFinite(config.fixedDt) ? Number(config.fixedDt) : null;
    this.rng = mulberry32(this.initialSeed);
    this.state = this.createInitialState();
  }

  reset(): { state: SimState; events: SimEvent[] } {
    this.rng = mulberry32(this.initialSeed);
    this.events = [];
    this.gearIdCounter = 0;
    this.boltIdCounter = 0;
    this.powerUpIdCounter = 0;
    this.generationHeight = 0;
    this.generationAngle = 0;
    this.cleanupTimer = 0;
    this.timeSinceLastLanding = Infinity;
    this.recentComboGearIds.clear();
    this.unlockedThisRun.clear();
    this.orbitAngleTarget = Math.PI / 2;
    this.cameraY = 8.1;
    this.deathFreezeTimer = 0;
    this.nextChallengeZoneHeight = 100;
    this.challengeZoneEntryScore = 0;
    this.windGearCount = 0;
    this.bouncyGearCount = 0;
    this.powerUpCount = 0;
    this.completedChallengeZones = 0;
    this.shieldSaveCount = 0;
    this.airBoltChain = 0;
    this.bestAirBoltChain = 0;
    this.consecutiveCrumble = 0;
    this.nextMilestoneGearHeight = 25;
    this.state = this.createInitialState();
    this.state.gameState = "playing";
    this.seedInitialLayout();
    this.updateBoltPositions();
    this.updatePowerUpPositions();
    return this.flush();
  }

  step(action: SimAction | number, dt?: number): { state: SimState; events: SimEvent[] } {
    const resolvedAction = typeof action === 'number'
      ? ClockworkClimbSimulation.DISCRETE_ACTIONS[action] ?? { moveX: 0, moveY: 0, jump: false }
      : action;
    const stepDt = this.fixedDt ?? (Number.isFinite(dt) ? Number(dt) : DEFAULT_FIXED_DT);
    if (stepDt <= 0) {
      return this.flushBridge();
    }

    if (this.state.gameState === "gameover" || this.state.gameState === "title") {
      return this.flushBridge();
    }

    if (this.state.gameState === "dying") {
      this.advanceDying(stepDt);
      return this.flushBridge();
    }

    this.state.elapsedTime += stepDt;
    this.state.gameTime += stepDt;
    this.timeSinceLastLanding += stepDt;

    if (this.state.comboLandings > 0 && this.timeSinceLastLanding > COMBO_WINDOW) {
      this.breakCombo();
    }

    this.generateAhead();
    this.updateGears(stepDt);
    this.resolveGrounding(stepDt);
    this.resolveCeilingBlock();
    this.advancePlayer(resolvedAction, stepDt);
    this.handlePoleCollision();
    this.updateBoltPositions();
    this.updatePowerUpPositions();
    this.handleBoltCollection();
    this.handlePowerUpCollection();
    this.updateOrbit(stepDt);
    this.updateScores();
    this.updateZone();
    this.updateChallengeZone();
    this.cleanupTimer += stepDt;
    if (this.cleanupTimer >= 2) {
      this.cleanupTimer = 0;
      this.cleanupBelow();
    }
    this.checkAchievements();
    this.checkDeath();

    return this.flushBridge();
  }

  getState(): SimState {
    return cloneState(this.state);
  }

  getObservation(): Float64Array {
    const player = this.state.player;
    const activeGear = this.state.activeGearId === null
      ? null
      : this.state.gears.find((gear) => gear.id === this.state.activeGearId) ?? null;
    const nearestBolt = this.findNearestAvailableBolt();
    const heightNorm = clamp(this.state.heightMaxReached / 120, 0, 1);
    return new Float64Array([
      normalizeSigned(player.x, 8),
      clamp(player.y / 120, 0, 1),
      normalizeSigned(player.z, 8),
      normalizeSigned(player.vx, 12),
      normalizeSigned(player.vy, 20),
      normalizeSigned(player.vz, 12),
      player.onGround ? 1 : 0,
      clamp(player.speedBoostTimer / 0.9, 0, 1),
      activeGear ? normalizeSigned(activeGear.x - player.x, 8) : 0,
      activeGear ? clamp((getGearTopY(activeGear) - player.y + 4) / 8, 0, 1) : 0,
      activeGear ? normalizeSigned(activeGear.z - player.z, 8) : 0,
      nearestBolt ? normalizeSigned(nearestBolt.x - player.x, 8) : 0,
      nearestBolt ? clamp((nearestBolt.y - player.y + 4) / 8, 0, 1) : 0,
      nearestBolt ? normalizeSigned(nearestBolt.z - player.z, 8) : 0,
      clamp(this.state.comboMultiplier / 5, 0, 1),
      clamp(this.state.boltCount / 25, 0, 1),
      heightNorm,
      normalizeAngle(this.state.orbitAngle),
      clamp(player.boltMagnetTimer / 8, 0, 1),
      clamp(player.slowMoTimer / 3, 0, 1),
      player.shieldActive ? 1 : 0,
      this.state.inChallengeZone ? 1 : 0,
    ]);
  }

  private createInitialState(): SimState {
    const player: SimPlayer = {
      x: 0,
      y: 2,
      z: 2,
      vx: 0,
      vy: 0,
      vz: 0,
      onGround: true,
      highestY: 2,
      prevY: 2,
      speedBoostTimer: 0,
      speedBoostStrength: 1,
      boltMagnetTimer: 0,
      slowMoTimer: 0,
      shieldActive: false,
      lastLandedGearX: 0,
      lastLandedGearY: 0,
      lastLandedGearZ: 0,
    };

    return {
      gameState: "title",
      player,
      gears: [],
      bolts: [],
      powerUps: [],
      score: 0,
      heightScore: 0,
      heightMaxReached: 0,
      boltCount: 0,
      boltScore: 0,
      comboLandings: 0,
      comboMultiplier: 1,
      bestCombo: 1,
      gameTime: 0,
      elapsedTime: 0,
      activeGearId: null,
      orbitAngle: Math.PI / 2,
      nextMilestone: 25,
      currentZoneIndex: 0,
      inChallengeZone: false,
      challengeZoneCenter: 0,
      windGearCount: 0,
      bouncyGearCount: 0,
      powerUpCount: 0,
      completedChallengeZones: 0,
      shieldSaveCount: 0,
      airBoltChain: 0,
      bestAirBoltChain: 0,
    };
  }

  private seedInitialLayout() {
    const startGear = this.createGear({
      x: 0,
      y: -0.2,
      z: 0,
      radius: 2.6,
      height: 0.4,
      rotationSpeed: 0.28,
      variant: "normal",
    });
    this.state.gears.push(startGear);

    let height = 0;
    let angle = this.randomRange(0, Math.PI * 2);
    for (let index = 1; index < 40; index += 1) {
      const band = getDifficultyBand(height);
      height += this.randomRange(band.verticalMin, band.verticalMax);
      angle += this.randomRange(0.75, 1.75);

      // Insert milestone gear at zone boundaries (25m, 50m, 75m, 100m)
      if (this.nextMilestoneGearHeight <= 100 && height >= this.nextMilestoneGearHeight) {
        this.spawnMilestoneGear(this.nextMilestoneGearHeight, angle);
        this.nextMilestoneGearHeight += 25;
      }

      const radius = this.randomRange(band.radiusMin, band.radiusMax);
      let gearX = 0;
      let gearZ = 0;
      let placed = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const tryAngle = attempt === 0 ? angle : angle + this.randomRange(-0.8, 0.8);
        const distance = this.randomRange(band.distanceMin, band.distanceMax);
        gearX = Math.cos(tryAngle) * distance;
        gearZ = Math.sin(tryAngle) * distance;
        if (!this.isGearOverlapping(gearX, height, gearZ, radius)) {
          placed = true;
          break;
        }
      }
      if (!placed) continue; // skip this gear entirely rather than overlap
      const variant = this.pickGearVariant(height);
      const gear = this.createGear({
        x: gearX,
        y: height,
        z: gearZ,
        radius,
        height: 0.3,
        rotationSpeed: this.randomRange(band.rotationMin, band.rotationMax),
        variant,
      });
      this.state.gears.push(gear);
      this.trySpawnBolt(gear);
      this.trySpawnPowerUp(gear);
    }

    this.generationHeight = height;
    this.generationAngle = angle;
  }

  private createGear(input: {
    x: number;
    y: number;
    z: number;
    radius: number;
    height: number;
    rotationSpeed: number;
    variant: GearVariant;
  }): SimGear {
    return {
      id: this.gearIdCounter++,
      x: input.x,
      y: input.y,
      z: input.z,
      radius: input.radius,
      height: input.height,
      rotationSpeed: input.rotationSpeed,
      rotationDir: this.rng() > 0.5 ? 1 : -1,
      variant: input.variant,
      active: true,
      currentRotation: 0,
      crumbleArmed: false,
      crumbleTimer: 0,
      crumbleFallVelocity: 0,
      crumbleFallDistance: 0,
      reverseTimer: 0,
      reverseInterval: 3,
      reversePause: 0.35,
      pistonTime: this.randomRange(0, Math.PI * 2),
      windAngle: this.randomRange(0, Math.PI * 2),
      windStrength: this.randomRange(2.5, 4.0),
      challenge: false,
    };
  }

  private createBolt(gear: SimGear): SimBolt {
    return {
      id: this.boltIdCounter++,
      gearId: gear.id,
      x: gear.x,
      y: getGearTopY(gear) + 0.75,
      z: gear.z,
      available: true,
    };
  }

  private createPowerUp(gear: SimGear, type: SimPowerUp["type"]): SimPowerUp {
    return {
      id: this.powerUpIdCounter++,
      gearId: gear.id,
      type,
      x: gear.x,
      y: getGearTopY(gear) + 1.25,
      z: gear.z,
      available: true,
    };
  }

  private trySpawnBolt(gear: SimGear) {
    if (gear.variant === "milestone") {
      // Milestone gears always have a bolt
      this.state.bolts.push(this.createBolt(gear));
      return;
    }
    if (gear.variant === "crumbling" || this.rng() >= 0.3) {
      return;
    }
    this.state.bolts.push(this.createBolt(gear));
  }

  private trySpawnPowerUp(gear: SimGear) {
    if (gear.y < 15 || this.rng() >= 0.10) {
      return;
    }
    const types: SimPowerUp["type"][] = ["bolt_magnet", "slow_mo", "shield"];
    const type = types[Math.floor(this.rng() * types.length)];
    this.state.powerUps.push(this.createPowerUp(gear, type));
  }

  private generateAhead() {
    // Generate any challenge zones that are now within lookahead range
    while (this.nextChallengeZoneHeight <= this.state.heightMaxReached + 65) {
      this.generateChallengeZone(this.nextChallengeZoneHeight);
      this.nextChallengeZoneHeight += 100;
    }

    let height = this.generationHeight;
    let angle = this.generationAngle;
    let batchesGenerated = 0;

    while (height - this.state.heightMaxReached <= 40 && batchesGenerated < 5) {
      for (let index = 0; index < 10; index += 1) {
        const band = getDifficultyBand(height);
        height += this.randomRange(band.verticalMin, band.verticalMax);
        angle += this.randomRange(0.75, 1.75);

        // Insert milestone gear at zone boundaries (25m, 50m, 75m, 100m)
        if (this.nextMilestoneGearHeight <= 100 && height >= this.nextMilestoneGearHeight) {
          this.spawnMilestoneGear(this.nextMilestoneGearHeight, angle);
          this.nextMilestoneGearHeight += 25;
        }

        const radius = this.randomRange(band.radiusMin, band.radiusMax);
        let gearX = 0;
        let gearZ = 0;
        let placed = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const tryAngle = attempt === 0 ? angle : angle + this.randomRange(-0.8, 0.8);
          const distance = this.randomRange(band.distanceMin, band.distanceMax);
          gearX = Math.cos(tryAngle) * distance;
          gearZ = Math.sin(tryAngle) * distance;
          if (!this.isGearOverlapping(gearX, height, gearZ, radius)) {
            placed = true;
            break;
          }
        }
        if (!placed) continue; // skip rather than overlap
        const variant = this.pickGearVariant(height);
        const gear = this.createGear({
          x: gearX,
          y: height,
          z: gearZ,
          radius,
          height: 0.3,
          rotationSpeed: this.randomRange(band.rotationMin, band.rotationMax),
          variant,
        });
        this.state.gears.push(gear);
        this.trySpawnBolt(gear);
        this.trySpawnPowerUp(gear);
      }
      batchesGenerated += 1;
    }

    this.generationHeight = height;
    this.generationAngle = angle;
  }

  private spawnMilestoneGear(targetHeight: number, currentAngle: number) {
    // Large, safe, golden milestone gear at zone boundaries
    const angle = currentAngle + this.randomRange(-0.3, 0.3);
    const distance = this.randomRange(1.5, 2.5);
    const gear = this.createGear({
      x: Math.cos(angle) * distance,
      y: targetHeight,
      z: Math.sin(angle) * distance,
      radius: 2.2, // Larger than normal (normal is ~1.3–2.0)
      height: 0.4,
      rotationSpeed: 0.2, // Slow, stately rotation
      variant: "milestone",
    });
    this.state.gears.push(gear);
    // Always spawn a bolt on milestone gears as a reward
    this.state.bolts.push(this.createBolt(gear));
    this.consecutiveCrumble = 0; // Reset chain counter
  }

  private generateChallengeZone(centerY: number) {
    const count = 8 + Math.floor(this.rng() * 5); // 8–12 gears
    let angle = this.generationAngle;

    for (let index = 0; index < count; index += 1) {
      const offsetY = this.randomRange(-7, 8);
      angle += this.randomRange(0.65, 1.55);
      const radius = this.randomRange(1.3, 2.1);
      const gearY = centerY + offsetY;

      // Find a non-overlapping position (challenge zones are dense, so try harder)
      let gearX = 0;
      let gearZ = 0;
      let placed = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const tryAngle = attempt === 0 ? angle : angle + this.randomRange(-0.8, 0.8);
        const distance = this.randomRange(1.5, 2.8);
        gearX = Math.cos(tryAngle) * distance;
        gearZ = Math.sin(tryAngle) * distance;
        if (!this.isGearOverlapping(gearX, gearY, gearZ, radius)) {
          placed = true;
          break;
        }
      }
      if (!placed) continue; // skip rather than stack gears

      const variant = index < 2 ? "normal" : this.pickGearVariant(centerY);
      const gear = this.createGear({
        x: gearX,
        y: gearY,
        z: gearZ,
        radius,
        height: 0.3,
        rotationSpeed: this.randomRange(0.45, 1.1),
        variant,
      });
      gear.challenge = true;
      this.state.gears.push(gear);
      // Always spawn a bolt on challenge gears
      this.state.bolts.push(this.createBolt(gear));
      // Normal power-up chance applies
      this.trySpawnPowerUp(gear);
    }
  }

  private isGearOverlapping(x: number, y: number, z: number, radius: number): boolean {
    for (const existing of this.state.gears) {
      const dx = x - existing.x;
      const dz = z - existing.z;
      const dy = Math.abs(y - existing.y);
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const minHorizontal = (radius + existing.radius) * 1.1;
      // Only check horizontal overlap if gears are vertically close enough to visually intersect
      // Gear height is 0.3; if vertical gap < 1.0, they can look stacked/sandwiched
      if (dy < 1.0 && horizontalDist < minHorizontal) {
        return true;
      }
    }
    return false;
  }

  private pickGearVariant(height: number): GearVariant {
    // Chain breaker: after 3 consecutive crumbling gears, force a safe one
    const blockCrumble = this.consecutiveCrumble >= 3;

    // Piston: independent check at 55m+
    if (height >= 55 && this.rng() < 0.14) {
      this.consecutiveCrumble = 0;
      return "piston";
    }
    // Bouncy: starts at 20m
    if (height >= 20 && this.rng() < 0.09) {
      this.consecutiveCrumble = 0;
      return "bouncy";
    }

    const roll = this.rng();
    let variant: GearVariant;

    if (height >= 100) {
      // Ultra-hard: all variants, heavy on the hard ones
      if (roll < 0.18) variant = "reverse";
      else if (roll < 0.32) variant = "wind";
      else if (roll < 0.46) variant = "magnetic";
      else if (roll < 0.60) variant = "speed";
      else if (roll < 0.76) variant = "crumbling";
      else variant = "normal";
    } else if (height >= 75) {
      if (roll < 0.20) variant = "reverse";
      else if (roll < 0.34) variant = "wind";
      else if (roll < 0.48) variant = "magnetic";
      else if (roll < 0.62) variant = "speed";
      else if (roll < 0.76) variant = "crumbling";
      else variant = "normal";
    } else if (height >= 50) {
      if (roll < 0.17) variant = "wind";
      else if (roll < 0.33) variant = "magnetic";
      else if (roll < 0.48) variant = "speed";
      else if (roll < 0.64) variant = "crumbling";
      else variant = "normal";
    } else if (height >= 40) {
      // Wind starts to appear
      if (roll < 0.08) variant = "wind";
      else if (roll < 0.20) variant = "magnetic";
      else if (roll < 0.38) variant = "speed";
      else if (roll < 0.56) variant = "crumbling";
      else variant = "normal";
    } else if (height >= 35) {
      // Magnetic starts to appear
      if (roll < 0.12) variant = "magnetic";
      else if (roll < 0.30) variant = "speed";
      else if (roll < 0.50) variant = "crumbling";
      else variant = "normal";
    } else if (height >= 25) {
      // More aggressive crumbling + speed
      if (roll < 0.24) variant = "speed";
      else if (roll < 0.50) variant = "crumbling";
      else variant = "normal";
    } else {
      variant = "normal";
    }

    // Chain breaker enforcement
    if (variant === "crumbling" && blockCrumble) {
      variant = "normal";
    }

    // Track consecutive crumbling
    if (variant === "crumbling") {
      this.consecutiveCrumble += 1;
    } else {
      this.consecutiveCrumble = 0;
    }

    return variant;
  }

  private updateGears(dt: number) {
    for (const gear of this.state.gears) {
      if (gear.variant === "piston") {
        gear.pistonTime += dt;
      }

      if (gear.variant === "wind") {
        gear.windAngle += dt * 0.4; // Slowly rotate wind direction
      }

      gear.reverseTimer += dt;
      if (gear.variant === "reverse" && gear.reverseTimer >= gear.reverseInterval) {
        gear.reverseTimer -= gear.reverseInterval;
        gear.rotationDir *= -1;
      }

      gear.currentRotation += getGearAngularVelocity(gear) * dt;

      if (!gear.crumbleArmed) {
        continue;
      }

      gear.crumbleTimer += dt;
      if (gear.crumbleTimer >= 1.5) {
        gear.active = false;
        gear.crumbleFallVelocity += 25 * dt;
        gear.crumbleFallDistance += gear.crumbleFallVelocity * dt;
      }
    }
  }

  private resolveGrounding(dt: number) {
    const player = this.state.player;
    let foundGround = false;
    const wasOnGround = player.onGround;
    const landingSpeed = Math.max(0, -player.vy);

    if (player.vy <= 0) {
      for (const gear of this.state.gears) {
        const gearBottom = gear.y - gear.height / 2;
        if (player.prevY < gearBottom - 0.05) {
          continue;
        }

        const result = checkGearCollision(gear, player, PLAYER_RADIUS);
        if (!result.onGear) {
          continue;
        }

        player.onGround = true;
        player.y = result.y;
        player.vy = 0;

        if (!wasOnGround) {
          this.onPlayerLand(gear, landingSpeed);
        }

        player.x += result.momentumX * dt;
        player.z += result.momentumZ * dt;
        this.state.activeGearId = gear.id;
        foundGround = true;
        break;
      }
    }

    if (!foundGround) {
      player.onGround = false;
      this.state.activeGearId = null;
    }
  }

  private onPlayerLand(gear: SimGear, landingSpeed: number) {
    this.airBoltChain = 0;
    this.state.airBoltChain = 0;

    // Track last landing position for shield save
    this.state.player.lastLandedGearX = gear.x;
    this.state.player.lastLandedGearY = getGearTopY(gear);
    this.state.player.lastLandedGearZ = gear.z;

    if (gear.variant === "crumbling" && !gear.crumbleArmed) {
      gear.crumbleArmed = true;
      gear.crumbleTimer = 0;
    }

    const nearMissDistance = Math.hypot(this.state.player.x - gear.x, this.state.player.z - gear.z);
    this.events.push({
      type: "gear_land",
      gearId: gear.id,
      variant: gear.variant,
      landingSpeed,
      nearMiss: nearMissDistance > gear.radius * 0.7,
      x: this.state.player.x,
      y: getGearTopY(gear),
      z: this.state.player.z,
    });

    if (gear.variant === "speed") {
      this.state.player.speedBoostStrength = Math.max(this.state.player.speedBoostStrength, 1.55);
      this.state.player.speedBoostTimer = Math.max(this.state.player.speedBoostTimer, 0.9);
      this.events.push({
        type: "speed_boost",
        x: this.state.player.x,
        y: this.state.player.y,
        z: this.state.player.z,
      });
    }

    if (gear.variant === "wind") {
      this.windGearCount += 1;
      this.state.windGearCount = this.windGearCount;
    }

    if (gear.variant === "bouncy") {
      this.bouncyGearCount += 1;
      this.state.bouncyGearCount = this.bouncyGearCount;
    }

    this.handleComboLanding(gear.id);

    if (gear.variant === "piston") {
      this.state.player.vy = PISTON_LAUNCH_VELOCITY;
      this.state.player.onGround = false;
      this.events.push({
        type: "piston_launch",
        x: this.state.player.x,
        y: this.state.player.y,
        z: this.state.player.z,
      });
    }
  }

  private resolveCeilingBlock() {
    const player = this.state.player;
    if (player.vy <= 0) {
      return;
    }

    for (const gear of this.state.gears) {
      const block = checkBlockFromBelow(gear, player, PLAYER_HEIGHT, PLAYER_RADIUS);
      if (!block.blocked) {
        continue;
      }

      player.y = block.capY;
      player.vy = 0;
      this.events.push({ type: "gear_block" });
      break;
    }
  }

  private advancePlayer(action: SimAction, dt: number) {
    const player = this.state.player;
    player.prevY = player.y;
    player.speedBoostTimer = Math.max(0, player.speedBoostTimer - dt);
    player.boltMagnetTimer = Math.max(0, player.boltMagnetTimer - dt);
    player.slowMoTimer = Math.max(0, player.slowMoTimer - dt);

    const speedBoost = player.speedBoostTimer > 0
      ? lerp(player.speedBoostStrength, 1, 1 - player.speedBoostTimer / 0.9)
      : 1;
    if (player.speedBoostTimer === 0) {
      player.speedBoostStrength = 1;
    }

    const speed = PLAYER_MOVE_SPEED * speedBoost;
    const moveX = clamp(action.moveX, -1, 1);
    const moveY = clamp(action.moveY, -1, 1);
    const cameraYaw = this.state.orbitAngle - Math.PI / 2;
    const sinYaw = Math.sin(cameraYaw);
    const cosYaw = Math.cos(cameraYaw);
    const worldX = moveX * cosYaw - moveY * sinYaw;
    const worldZ = moveX * sinYaw + moveY * cosYaw;

    player.vx = worldX * speed;
    player.vz = worldZ * speed;
    player.x += player.vx * dt;
    player.z += player.vz * dt;

    // Apply gear-specific forces while grounded
    if (player.onGround && this.state.activeGearId !== null) {
      const activeGear = this.state.gears.find((g) => g.id === this.state.activeGearId) ?? null;
      if (activeGear?.variant === "wind") {
        player.x += Math.cos(activeGear.windAngle) * activeGear.windStrength * dt;
        player.z += Math.sin(activeGear.windAngle) * activeGear.windStrength * dt;
      }
      if (activeGear?.variant === "magnetic") {
        const dx = activeGear.x - player.x;
        const dz = activeGear.z - player.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.05) {
          const pullStrength = 3.5;
          player.x += (dx / dist) * pullStrength * dt;
          player.z += (dz / dist) * pullStrength * dt;
        }
      }
    }

    if (!player.onGround) {
      const effectiveGravity = player.slowMoTimer > 0 ? GRAVITY * 0.6 : GRAVITY;
      player.vy -= effectiveGravity * dt;
    } else {
      player.vy = 0;
    }

    if (player.onGround && action.jump) {
      const activeGear = this.state.activeGearId !== null
        ? this.state.gears.find((g) => g.id === this.state.activeGearId) ?? null
        : null;
      const isBouncy = activeGear?.variant === "bouncy";
      player.vy = JUMP_VELOCITY * (isBouncy ? 1.4 : 1);
      player.onGround = false;
      if (isBouncy) {
        // bounce_jump supersedes jump — handler includes all effects
        this.events.push({ type: "bounce_jump", x: player.x, y: player.y, z: player.z });
      } else {
        this.events.push({ type: "jump", x: player.x, y: player.y, z: player.z });
      }
    }

    player.y += player.vy * dt;
    if (player.y > player.highestY) {
      player.highestY = player.y;
    }
  }

  private handlePoleCollision() {
    const player = this.state.player;
    const distFromCenter = Math.hypot(player.x, player.z);
    const minRadius = 1.1;
    if (distFromCenter < minRadius && distFromCenter > 0.001) {
      const pushOut = minRadius / distFromCenter;
      player.x *= pushOut;
      player.z *= pushOut;
    }
  }

  private updateBoltPositions() {
    for (const bolt of this.state.bolts) {
      const gear = this.state.gears.find((candidate) => candidate.id === bolt.gearId);
      if (!gear) {
        continue;
      }
      bolt.x = gear.x;
      bolt.y = getGearTopY(gear) + 0.75;
      bolt.z = gear.z;
    }
  }

  private updatePowerUpPositions() {
    for (const powerUp of this.state.powerUps) {
      const gear = this.state.gears.find((g) => g.id === powerUp.gearId);
      if (!gear) {
        continue;
      }
      powerUp.x = gear.x;
      powerUp.y = getGearTopY(gear) + 1.25;
      powerUp.z = gear.z;
    }
  }

  private handleBoltCollection() {
    const player = this.state.player;
    const magnetActive = player.boltMagnetTimer > 0;
    const collectRadiusSq = magnetActive ? 4 * 4 : 0.75 * 0.75;

    for (const bolt of this.state.bolts) {
      if (!bolt.available) {
        continue;
      }

      const dx = player.x - bolt.x;
      const dy = player.y + 0.3 - bolt.y;
      const dz = player.z - bolt.z;
      if (dx * dx + dy * dy + dz * dz > collectRadiusSq) {
        continue;
      }

      bolt.available = false;
      this.state.boltCount += 1;
      this.state.boltScore += BOLT_SCORE_VALUE;
      if (player.onGround) {
        this.airBoltChain = 0;
      } else {
        this.airBoltChain += 1;
        this.bestAirBoltChain = Math.max(this.bestAirBoltChain, this.airBoltChain);
      }
      this.state.airBoltChain = this.airBoltChain;
      this.state.bestAirBoltChain = this.bestAirBoltChain;
      this.events.push({
        type: "bolt_collect",
        boltId: bolt.id,
        totalBolts: this.state.boltCount,
        x: bolt.x,
        y: bolt.y,
        z: bolt.z,
      });
    }
  }

  private handlePowerUpCollection() {
    const player = this.state.player;
    for (const powerUp of this.state.powerUps) {
      if (!powerUp.available) {
        continue;
      }

      const dx = player.x - powerUp.x;
      const dy = player.y + 0.3 - powerUp.y;
      const dz = player.z - powerUp.z;
      if (dx * dx + dy * dy + dz * dz > 1.0 * 1.0) {
        continue;
      }

      powerUp.available = false;
      this.powerUpCount += 1;
      this.state.powerUpCount = this.powerUpCount;
      switch (powerUp.type) {
        case "bolt_magnet":
          player.boltMagnetTimer = 8;
          break;
        case "slow_mo":
          player.slowMoTimer = 3;
          break;
        case "shield":
          player.shieldActive = true;
          break;
      }
      this.events.push({
        type: "powerup_collect",
        powerUpType: powerUp.type,
        x: powerUp.x,
        y: powerUp.y,
        z: powerUp.z,
      });
    }
  }

  private updateOrbit(dt: number) {
    const player = this.state.player;
    const verticalLead = clamp(player.vy * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (player.onGround ? 5.5 : 4));
    const orbitLerp = 1 - Math.exp(-dt * 7);

    if (player.onGround) {
      const playerDist = Math.hypot(player.x, player.z);
      const baseAngle = playerDist > 0.5 ? Math.atan2(player.z, player.x) : this.orbitAngleTarget;
      let bestNudge = 0;
      const maxNudge = 1.3;
      const nudgeStep = 0.05;
      const angleTolerance = 0.18;
      const verticalWindow = 3;

      const isClear = (testAngle: number): boolean => {
        const camX = Math.cos(testAngle) * ORBIT_RADIUS;
        const camZ = Math.sin(testAngle) * ORBIT_RADIUS;
        const toPlayerX = player.x - camX;
        const toPlayerZ = player.z - camZ;
        const toPlayerLen = Math.hypot(toPlayerX, toPlayerZ) || 1;
        const camToPlayerAngle = Math.atan2(toPlayerZ, toPlayerX);

        for (const gear of this.state.gears) {
          if (gear.id === this.state.activeGearId) continue;
          if (Math.abs(gear.y - player.y) > verticalWindow) continue;
          const toGearX = gear.x - camX;
          const toGearZ = gear.z - camZ;
          const toGearLen = Math.hypot(toGearX, toGearZ) || 1;
          if (toGearLen >= toPlayerLen) continue;
          const camToGearAngle = Math.atan2(toGearZ, toGearX);
          let angleDelta = camToGearAngle - camToPlayerAngle;
          while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
          while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
          const gearAngularHalf = Math.atan2(gear.radius, toGearLen);
          if (Math.abs(angleDelta) < angleTolerance + gearAngularHalf) {
            return false;
          }
        }
        return true;
      };

      if (!isClear(baseAngle)) {
        // Try alternating positive/negative nudges to find closest clear angle
        let found = false;
        for (let step = 1; step <= maxNudge / nudgeStep; step += 1) {
          const offset = step * nudgeStep;
          if (isClear(baseAngle + offset)) {
            bestNudge = offset;
            found = true;
            break;
          }
          if (isClear(baseAngle - offset)) {
            bestNudge = -offset;
            found = true;
            break;
          }
        }
        if (!found) bestNudge = maxNudge;
      }

      this.orbitAngleTarget = baseAngle + bestNudge;
    }

    let angleDiff = this.orbitAngleTarget - this.state.orbitAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    // Cap angular velocity to prevent wild spins on large angle jumps
    const maxAngularStep = 2.5 * dt; // ~143°/s — smooth but responsive
    const angularStep = angleDiff * orbitLerp;
    this.state.orbitAngle += clamp(angularStep, -maxAngularStep, maxAngularStep);

    const targetCamY = player.y + 6.1 + verticalLead;
    this.cameraY = lerp(this.cameraY, targetCamY, followLerp);
  }

  private updateScores() {
    const currentHeight = Math.max(0, Math.floor(this.state.player.y));
    const previousReached = this.state.heightMaxReached;
    if (currentHeight > this.state.heightMaxReached) {
      const delta = currentHeight - this.state.heightMaxReached;
      this.state.heightMaxReached = currentHeight;
      const challengeBonus = this.state.inChallengeZone ? 2 : 1;
      this.state.heightScore += delta * this.state.comboMultiplier * challengeBonus;
    }
    this.state.score = this.state.heightScore + this.state.boltScore;

    if (this.state.heightMaxReached > previousReached && this.state.heightMaxReached >= this.state.nextMilestone) {
      while (this.state.heightMaxReached >= this.state.nextMilestone) {
        this.events.push({
          type: "milestone",
          height: this.state.nextMilestone,
          nextMilestone: this.state.nextMilestone + 25,
        });
        this.state.nextMilestone += 25;
      }
    }
  }

  private handleComboLanding(gearId: number) {
    const withinWindow = this.timeSinceLastLanding <= COMBO_WINDOW;
    const sameGear = this.recentComboGearIds.has(gearId);
    let progressed = false;

    if (!sameGear) {
      if (withinWindow || this.state.comboLandings === 0) {
        this.state.comboLandings += 1;
      } else {
        this.state.comboLandings = 1;
        this.recentComboGearIds.clear();
      }
      progressed = true;
    }

    this.recentComboGearIds.add(gearId);
    this.timeSinceLastLanding = 0;
    const newMultiplier = comboLandingsToMultiplier(this.state.comboLandings);
    if (newMultiplier > 1 && newMultiplier !== this.state.comboMultiplier) {
      this.events.push({ type: "combo_up", multiplier: newMultiplier });
    }
    this.state.comboMultiplier = newMultiplier;
    this.state.bestCombo = Math.max(this.state.bestCombo, this.state.comboMultiplier);

    if (!progressed && this.state.comboMultiplier === 1) {
      return;
    }
  }

  private breakCombo() {
    if (this.state.comboMultiplier > 1) {
      this.events.push({ type: "combo_break" });
    }
    this.state.comboLandings = 0;
    this.state.comboMultiplier = 1;
    this.timeSinceLastLanding = Infinity;
    this.recentComboGearIds.clear();
  }

  private updateZone() {
    const zoneIndex = getZoneIndex(this.state.player.y);
    if (zoneIndex !== this.state.currentZoneIndex) {
      this.state.currentZoneIndex = zoneIndex;
      this.events.push({ type: "zone_change", zoneIndex });
    }
  }

  private updateChallengeZone() {
    const wasInZone = this.state.inChallengeZone;
    const nowInZone = isInChallengeZone(this.state.player.y);

    if (!wasInZone && nowInZone) {
      this.state.inChallengeZone = true;
      this.state.challengeZoneCenter = getChallengeZoneCenter(this.state.player.y);
      this.challengeZoneEntryScore = this.state.score;
      this.events.push({
        type: "challenge_zone_enter",
        zoneCenter: this.state.challengeZoneCenter,
      });
    } else if (wasInZone && !nowInZone) {
      this.state.inChallengeZone = false;
      const bonusScore = Math.max(0, this.state.score - this.challengeZoneEntryScore);
      this.completedChallengeZones += 1;
      this.state.completedChallengeZones = this.completedChallengeZones;
      this.events.push({ type: "challenge_zone_exit", bonusScore });
    }
  }

  private checkAchievements() {
    const maybeUnlock = (id: string, condition: boolean) => {
      if (!condition || this.unlockedThisRun.has(id)) {
        return;
      }
      this.unlockedThisRun.add(id);
      this.events.push({ type: "achievement", id });
    };

    maybeUnlock("SKY_HIGH", this.state.heightMaxReached >= 50);
    maybeUnlock("CLOUD_WALKER", this.state.heightMaxReached >= 100);
    maybeUnlock("BOLT_COLLECTOR", this.state.boltCount >= 10);
    maybeUnlock("BOLT_HOARDER", this.state.boltCount >= 25);
    maybeUnlock("ENDURANCE", this.state.gameTime >= 60 && this.state.heightMaxReached >= 10);
    maybeUnlock("COMBO_STARTER", this.state.comboMultiplier >= 2);
    maybeUnlock("COMBO_MASTER", this.state.comboMultiplier >= 5);
    maybeUnlock("WIND_RIDER", this.state.windGearCount >= 3);
    maybeUnlock("BOUNCE_KING", this.state.bouncyGearCount >= 5);
    maybeUnlock("CHALLENGE_COMPLETE", this.state.completedChallengeZones >= 1);
    maybeUnlock("IRON_WORKS", this.state.heightMaxReached >= 25);
    maybeUnlock("GOLDEN_CLIMBER", this.state.heightMaxReached >= 75);
    maybeUnlock("CHROME_ABYSS", this.state.heightMaxReached >= 100);
    maybeUnlock("POWERUP_COLLECTOR", this.state.powerUpCount >= 5);
    maybeUnlock("SHIELD_SURVIVOR", this.state.shieldSaveCount >= 1);
  }

  private cleanupBelow() {
    const cutoffY = this.state.player.y - 40;
    const remainingGears = this.state.gears.filter((gear) => gear.y >= cutoffY);
    const remainingGearIds = new Set(remainingGears.map((gear) => gear.id));
    this.state.gears = remainingGears;
    this.state.bolts = this.state.bolts.filter((bolt) => {
      if (!remainingGearIds.has(bolt.gearId)) {
        return false;
      }
      return bolt.y >= cutoffY || !bolt.available;
    });
    this.state.powerUps = this.state.powerUps.filter((powerUp) => {
      if (!remainingGearIds.has(powerUp.gearId)) {
        return false;
      }
      return powerUp.y >= cutoffY || !powerUp.available;
    });
  }

  private isPlayerStranded(): boolean {
    const player = this.state.player;
    if (!player.onGround) return false;

    const activeGear = this.state.activeGearId !== null
      ? this.state.gears.find((g) => g.id === this.state.activeGearId)
      : null;
    if (!activeGear) return false;

    // For crumbling gears: check once crumble is underway
    // For non-crumbling gears: check if there's no upward path at all
    const isCrumbling = activeGear.variant === "crumbling" && activeGear.crumbleArmed;
    if (isCrumbling && activeGear.crumbleTimer < 0.8) return false;

    // Max jump height is ~3.6m (vy=12, gravity=20 → peak at vy²/2g = 3.6)
    const jumpReach = 4.0;
    const lateralReach = 5.0;

    let hasReachableAbove = false;
    for (const gear of this.state.gears) {
      if (gear.id === activeGear.id) continue;
      if (!gear.active) continue;
      if (gear.variant === "crumbling" && gear.crumbleArmed) continue;

      const dx = gear.x - player.x;
      const dz = gear.z - player.z;
      const dy = getGearTopY(gear) - player.y;
      const horizontalDist = Math.hypot(dx, dz);

      if (horizontalDist <= lateralReach && dy <= jumpReach && dy >= -2) {
        hasReachableAbove = true;
        break;
      }
    }

    if (hasReachableAbove) return false;

    // For non-crumbling gears, only trigger after a grace period to avoid
    // false positives during normal upward generation lag
    if (!isCrumbling) {
      // Player must have been on this gear for > 2 seconds with no path
      if (this.timeSinceLastLanding < 2) return false;
    }

    // Stranded — spawn a rescue gear above and to the side
    this.spawnRescueGear(player);
    return false; // Don't kill — we just gave them a way out
  }

  private spawnRescueGear(player: SimPlayer) {
    const angle = Math.atan2(player.z, player.x) + this.randomRange(0.8, 1.4);
    const distance = this.randomRange(1.5, 2.5);
    const gear = this.createGear({
      x: Math.cos(angle) * distance,
      y: player.y + this.randomRange(2.0, 3.0),
      z: Math.sin(angle) * distance,
      radius: 1.8,
      height: 0.3,
      rotationSpeed: 0.3,
      variant: "normal",
    });
    this.state.gears.push(gear);
    this.state.bolts.push(this.createBolt(gear));
    this.consecutiveCrumble = 0;
  }

  private checkDeath() {
    // Stranded detection: spawns a rescue gear if stuck (no longer kills)
    if (this.state.gameState === "playing") {
      this.isPlayerStranded();
    }

    if (this.state.player.y < this.cameraY - 12 && this.state.gameState === "playing") {
      // Shield intercepts the death
      if (this.state.player.shieldActive) {
        this.state.player.shieldActive = false;
        this.shieldSaveCount += 1;
        this.state.shieldSaveCount = this.shieldSaveCount;
        this.state.player.x = this.state.player.lastLandedGearX;
        this.state.player.y = this.state.player.lastLandedGearY + 1.5;
        this.state.player.z = this.state.player.lastLandedGearZ;
        this.state.player.vx = 0;
        this.state.player.vy = 0;
        this.state.player.vz = 0;
        this.state.player.onGround = false;
        this.events.push({
          type: "shield_save",
          x: this.state.player.x,
          y: this.state.player.y,
          z: this.state.player.z,
        });
        return;
      }

      this.state.gameState = "dying";
      this.deathFreezeTimer = 0.2;
      if (this.state.comboMultiplier > 1) {
        this.breakCombo();
      } else {
        this.state.comboLandings = 0;
        this.state.comboMultiplier = 1;
      }
      this.events.push({ type: "death_start" });
    }
  }

  private advanceDying(dt: number) {
    this.state.elapsedTime += dt;
    this.deathFreezeTimer -= dt;
    if (this.deathFreezeTimer > 0) {
      return;
    }
    this.state.gameState = "gameover";
    this.events.push({ type: "death" });
  }

  private findNearestAvailableBolt(): SimBolt | null {
    let nearest: SimBolt | null = null;
    let nearestDistSq = Infinity;
    for (const bolt of this.state.bolts) {
      if (!bolt.available) {
        continue;
      }
      const dx = bolt.x - this.state.player.x;
      const dy = bolt.y - this.state.player.y;
      const dz = bolt.z - this.state.player.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < nearestDistSq) {
        nearest = bolt;
        nearestDistSq = distSq;
      }
    }
    return nearest;
  }

  private flushBridge(): { state: SimState; events: SimEvent[] } {
    const result = this.flush();
    (result.state as any).gameOver = result.state.gameState === 'gameover';
    (result.state as any).alive = result.state.gameState !== 'gameover';
    return result;
  }

  private flush(): { state: SimState; events: SimEvent[] } {
    const state = cloneState(this.state);
    const events = this.events.map((event) => ({ ...event }));
    this.events = [];
    return { state, events };
  }

  private randomRange(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }
}

function getGearTopY(gear: SimGear): number {
  return gear.y + gear.height / 2 + 0.12 - gear.crumbleFallDistance + getPistonOffset(gear);
}

function getPistonOffset(gear: SimGear): number {
  if (gear.variant !== "piston") {
    return 0;
  }
  return Math.sin((gear.pistonTime / 1.5) * Math.PI * 2) * 0.15;
}

function getGearAngularVelocity(gear: SimGear): number {
  if (!gear.active) {
    return 0;
  }
  if (gear.variant === "reverse") {
    const cycleTime = gear.reverseTimer % gear.reverseInterval;
    if (cycleTime >= gear.reverseInterval - gear.reversePause) {
      return 0;
    }
  }
  const multiplier = gear.variant === "speed" ? 2 : 1;
  return gear.rotationSpeed * multiplier * gear.rotationDir;
}

function checkGearCollision(gear: SimGear, player: SimPlayer, playerRadius: number): LandingResult {
  if (!gear.active) {
    return { onGear: false, y: 0, momentumX: 0, momentumZ: 0 };
  }

  const dx = player.x - gear.x;
  const dz = player.z - gear.z;
  const distSq = dx * dx + dz * dz;
  const combinedRadius = gear.radius + playerRadius + 0.02;
  const gearTop = getGearTopY(gear);
  const isAbove = player.y >= gearTop - 0.2 && player.y <= gearTop + 0.2;
  if (distSq >= combinedRadius * combinedRadius || !isAbove) {
    return { onGear: false, y: 0, momentumX: 0, momentumZ: 0 };
  }

  const angularVelocity = getGearAngularVelocity(gear);
  return {
    onGear: true,
    y: gearTop,
    momentumX: dz * angularVelocity,
    momentumZ: -dx * angularVelocity,
  };
}

function checkBlockFromBelow(gear: SimGear, player: SimPlayer, playerHeight: number, playerRadius: number): BlockResult {
  if (!gear.active) {
    return { blocked: false, capY: 0 };
  }

  const dx = player.x - gear.x;
  const dz = player.z - gear.z;
  const distSq = dx * dx + dz * dz;
  const combinedRadius = gear.radius + playerRadius;
  if (distSq >= combinedRadius * combinedRadius) {
    return { blocked: false, capY: 0 };
  }

  const gearBottom = gear.y - gear.height / 2 - gear.crumbleFallDistance;
  const playerTop = player.y + playerHeight;
  if (player.y < gearBottom && playerTop > gearBottom) {
    return { blocked: true, capY: gearBottom - playerHeight };
  }

  return { blocked: false, capY: 0 };
}

function comboLandingsToMultiplier(landings: number): number {
  if (landings >= 8) return 5;
  if (landings >= 6) return 4;
  if (landings >= 4) return 3;
  if (landings >= 2) return 2;
  return 1;
}

function getDifficultyBand(height: number): DifficultyBand {
  if (height < 25) {
    return {
      danger: 0.05,
      distanceMax: 2.2,
      distanceMin: 1.4,
      radiusMax: 2.7,
      radiusMin: 1.9,
      rotationMax: 0.58,
      rotationMin: 0.28,
      verticalMax: 2.45,
      verticalMin: 2.15,
    };
  }
  if (height < 50) {
    return {
      danger: 0.32,
      distanceMax: 2.9,
      distanceMin: 1.9,
      radiusMax: 2.2,
      radiusMin: 1.45,
      rotationMax: 1.0,
      rotationMin: 0.62,
      verticalMax: 2.55,
      verticalMin: 2.2,
    };
  }
  if (height < 75) {
    return {
      danger: 0.62,
      distanceMax: 3.4,
      distanceMin: 2.3,
      radiusMax: 1.8,
      radiusMin: 1.1,
      rotationMax: 1.55,
      rotationMin: 1.0,
      verticalMax: 2.85,
      verticalMin: 2.4,
    };
  }
  if (height < 100) {
    return {
      danger: 0.88,
      distanceMax: 3.7,
      distanceMin: 2.6,
      radiusMax: 1.5,
      radiusMin: 1.0,
      rotationMax: 2.1,
      rotationMin: 1.35,
      verticalMax: 2.95,
      verticalMin: 2.45,
    };
  }
  // 100m+ ultra-hard band
  return {
    danger: 0.98,
    distanceMax: 4.0,
    distanceMin: 2.8,
    radiusMax: 1.2,
    radiusMin: 0.85,
    rotationMax: 2.8,
    rotationMin: 2.0,
    verticalMax: 3.0,
    verticalMin: 2.5,
  };
}

function getZoneIndex(height: number): number {
  if (height >= 100) return 4;
  if (height >= 75) return 3;
  if (height >= 50) return 2;
  if (height >= 25) return 1;
  return 0;
}

function isInChallengeZone(height: number): boolean {
  if (height < 90) return false;
  const nearestZone = Math.round(height / 100) * 100;
  if (nearestZone < 100) return false;
  return Math.abs(height - nearestZone) <= 10;
}

function getChallengeZoneCenter(height: number): number {
  return Math.round(height / 100) * 100;
}

function mulberry32(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cloneState(state: SimState): SimState {
  return {
    ...state,
    player: { ...state.player },
    gears: state.gears.map((gear) => ({ ...gear })),
    bolts: state.bolts.map((bolt) => ({ ...bolt })),
    powerUps: state.powerUps.map((powerUp) => ({ ...powerUp })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function normalizeSigned(value: number, maxMagnitude: number): number {
  return clamp(value / maxMagnitude, -1, 1);
}

function normalizeAngle(value: number): number {
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value / Math.PI;
}
