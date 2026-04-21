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

type PlacementContext = "normal" | "milestone" | "challenge";

type PlacementResult = {
  angle: number;
  anchorId: number | null;
  score: number;
  x: number;
  z: number;
};

const DEFAULT_FIXED_DT = 1 / 60;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 0.6;
const PLAYER_MOVE_SPEED = 5;
const JUMP_VELOCITY = 12;
const DOUBLE_JUMP_DURATION = 12;
const HIGH_ALTITUDE_REST_GEAR_HEIGHT = 100;
const REST_GEAR_RADIUS = 1.2;
const REST_GEAR_ROTATION_MAX = 1.2;
const PISTON_LAUNCH_VELOCITY = 18;
const GRAVITY = 20;
const ORBIT_RADIUS = 12;
const COMBO_WINDOW = 2.5;
const BOLT_SCORE_VALUE = 5;
const MAX_ROUTE_VERTICAL_STEP = 4.1;
const NORMAL_CLEARANCE_VERTICAL_WINDOW = 1.45;
const STACKED_VERTICAL_WINDOW = 3.1;
const STACKED_HORIZONTAL_GAP = 1.15;
const PATH_ANCHOR_WINDOW = 10;

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
  private highAltitudeGearStreak = 0;
  private nextHighAltitudeRestThreshold = 4;

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
    this.highAltitudeGearStreak = 0;
    this.nextHighAltitudeRestThreshold = 4;
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

  debugGenerateLayoutToHeight(targetHeight: number): SimState {
    const goalHeight = Math.max(0, targetHeight);
    let guard = 0;
    this.state.heightMaxReached = Math.max(this.state.heightMaxReached, goalHeight);
    while (this.generationHeight < goalHeight + 40 && guard < 12) {
      const before = this.generationHeight;
      this.generateAhead();
      if (this.generationHeight <= before) {
        break;
      }
      guard += 1;
    }
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
      doubleJumpAvailable: false,
      doubleJumpTimer: 0,
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

      // Insert milestone gear at zone boundaries (25m, 50m, 75m, 100m)
      if (this.nextMilestoneGearHeight <= 100 && height >= this.nextMilestoneGearHeight) {
        angle = this.spawnMilestoneGear(this.nextMilestoneGearHeight, angle);
        this.nextMilestoneGearHeight += 25;
      }

      const restGear = this.shouldSpawnRestGear(height);
      const radius = restGear ? REST_GEAR_RADIUS : this.randomRange(band.radiusMin, band.radiusMax);
      const placement = this.findGearPlacement({
        band,
        context: "normal",
        currentAngle: angle,
        radius,
        targetY: height,
      });
      if (!placement) continue;
      const variant = restGear ? "normal" : this.pickGearVariant(height);
      const gear = this.createGear({
        x: placement.x,
        y: height,
        z: placement.z,
        radius,
        height: 0.3,
        rotationSpeed: restGear ? this.randomRange(0.45, REST_GEAR_ROTATION_MAX) : this.randomRange(band.rotationMin, band.rotationMax),
        variant,
      });
      this.state.gears.push(gear);
      this.trySpawnBolt(gear);
      this.trySpawnPowerUp(gear);
      this.recordHighAltitudeGearSpawn(height, restGear);
      angle = placement.angle;
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
      windStrength: this.randomRange(1.5, 2.5),
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
    const type = this.pickPowerUpType(gear.y);
    this.state.powerUps.push(this.createPowerUp(gear, type));
  }

  private pickPowerUpType(height: number): SimPowerUp["type"] {
    if (height >= 100) {
      return this.weightedChoice<SimPowerUp["type"]>([
        ["bolt_magnet", 35],
        ["slow_mo", 25],
        ["shield", 25],
        ["double_jump", 15],
      ]);
    }
    if (height >= 75) {
      return this.weightedChoice<SimPowerUp["type"]>([
        ["bolt_magnet", 38],
        ["slow_mo", 27],
        ["shield", 25],
        ["double_jump", 10],
      ]);
    }
    if (height >= 50) {
      return this.weightedChoice<SimPowerUp["type"]>([
        ["bolt_magnet", 42],
        ["slow_mo", 30],
        ["shield", 23],
        ["double_jump", 5],
      ]);
    }
    return this.weightedChoice<SimPowerUp["type"]>([
      ["bolt_magnet", 40],
      ["slow_mo", 32],
      ["shield", 28],
    ]);
  }

  private weightedChoice<T>(options: Array<[T, number]>): T {
    const total = options.reduce((sum, [, weight]) => sum + weight, 0);
    let cursor = this.rng() * total;
    for (const [value, weight] of options) {
      cursor -= weight;
      if (cursor <= 0) {
        return value;
      }
    }
    return options[options.length - 1][0];
  }

  private shouldSpawnRestGear(height: number): boolean {
    return height >= HIGH_ALTITUDE_REST_GEAR_HEIGHT && this.highAltitudeGearStreak >= this.nextHighAltitudeRestThreshold - 1;
  }

  private recordHighAltitudeGearSpawn(height: number, restGear: boolean) {
    if (height < HIGH_ALTITUDE_REST_GEAR_HEIGHT) {
      this.highAltitudeGearStreak = 0;
      this.nextHighAltitudeRestThreshold = 4;
      return;
    }

    if (restGear) {
      this.highAltitudeGearStreak = 0;
      this.nextHighAltitudeRestThreshold = 4 + Math.floor(this.rng() * 2);
      return;
    }

    this.highAltitudeGearStreak += 1;
  }

  private getMaxPlayableGap(anchorRotationSpeed: number, band: DifficultyBand, basePlayableGap: number): number {
    if (anchorRotationSpeed <= 1.5 || band.rotationMax <= 1.5) {
      return basePlayableGap;
    }

    const factor = clamp(1.0 - (anchorRotationSpeed - 1.0) * 0.2, 0.6, 1.0);
    return basePlayableGap * factor;
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

        // Insert milestone gear at zone boundaries (25m, 50m, 75m, 100m)
        if (this.nextMilestoneGearHeight <= 100 && height >= this.nextMilestoneGearHeight) {
          angle = this.spawnMilestoneGear(this.nextMilestoneGearHeight, angle);
          this.nextMilestoneGearHeight += 25;
        }

        const restGear = this.shouldSpawnRestGear(height);
        const radius = restGear ? REST_GEAR_RADIUS : this.randomRange(band.radiusMin, band.radiusMax);
        const placement = this.findGearPlacement({
          band,
          context: "normal",
          currentAngle: angle,
          radius,
          targetY: height,
        });
        if (!placement) continue;
        const variant = restGear ? "normal" : this.pickGearVariant(height);
        const gear = this.createGear({
          x: placement.x,
          y: height,
          z: placement.z,
          radius,
          height: 0.3,
          rotationSpeed: restGear ? this.randomRange(0.45, REST_GEAR_ROTATION_MAX) : this.randomRange(band.rotationMin, band.rotationMax),
          variant,
        });
        this.state.gears.push(gear);
        this.trySpawnBolt(gear);
        this.trySpawnPowerUp(gear);
        this.recordHighAltitudeGearSpawn(height, restGear);
        angle = placement.angle;
      }
      batchesGenerated += 1;
    }

    this.generationHeight = height;
    this.generationAngle = angle;
  }

  private spawnMilestoneGear(targetHeight: number, currentAngle: number): number {
    // Large, safe, golden milestone gear at zone boundaries
    const band = getDifficultyBand(Math.max(0, targetHeight - 1));
    const placement = this.findGearPlacement({
      band,
      context: "milestone",
      currentAngle,
      radius: 2.2,
      targetY: targetHeight,
    }) ?? this.findSweptPlacement({
      context: "milestone",
      currentAngle,
      radius: 2.2,
      targetY: targetHeight,
    });
    const angle = placement?.angle ?? normalizeRadians(currentAngle + 0.9);
    const fallbackDistance = 4.2;
    const gear = this.createGear({
      x: placement?.x ?? Math.cos(angle) * fallbackDistance,
      y: targetHeight,
      z: placement?.z ?? Math.sin(angle) * fallbackDistance,
      radius: 2.2, // Larger than normal (normal is ~1.3–2.0)
      height: 0.4,
      rotationSpeed: 0.2, // Slow, stately rotation
      variant: "milestone",
    });
    this.state.gears.push(gear);
    // Always spawn a bolt on milestone gears as a reward
    this.state.bolts.push(this.createBolt(gear));
    this.consecutiveCrumble = 0; // Reset chain counter
    return angle;
  }

  private generateChallengeZone(centerY: number) {
    const count = 8 + Math.floor(this.rng() * 5); // 8–12 gears
    let angle = this.generationAngle;
    const challengeBand: DifficultyBand = {
      danger: 1,
      distanceMax: 3.1,
      distanceMin: 1.7,
      radiusMax: 2.1,
      radiusMin: 1.3,
      rotationMax: 1.1,
      rotationMin: 0.45,
      verticalMax: 2.25,
      verticalMin: 1.45,
    };

    for (let index = 0; index < count; index += 1) {
      const radius = this.randomRange(1.3, 2.1);
      const previousChallenge = this.getRecentChallengeAnchor(centerY);
      const baseY = previousChallenge ? previousChallenge.y : centerY - 7.5;
      const gearY = clamp(
        baseY + this.randomRange(challengeBand.verticalMin, challengeBand.verticalMax),
        centerY - 7.5,
        centerY + 8,
      );
      const placement = this.findGearPlacement({
        band: challengeBand,
        context: "challenge",
        currentAngle: angle,
        radius,
        targetY: gearY,
      });
      if (!placement) continue;

      const variant = index < 2 ? "normal" : this.pickGearVariant(centerY);
      const gear = this.createGear({
        x: placement.x,
        y: gearY,
        z: placement.z,
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
      angle = placement.angle;
    }
  }

  private isGearOverlapping(x: number, y: number, z: number, radius: number): boolean {
    for (const existing of this.state.gears) {
      const dx = x - existing.x;
      const dz = z - existing.z;
      const dy = Math.abs(y - existing.y);
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const minHorizontal = (radius + existing.radius) * 1.18;
      if (dy < NORMAL_CLEARANCE_VERTICAL_WINDOW && horizontalDist < minHorizontal) {
        return true;
      }
      if (dy < STACKED_VERTICAL_WINDOW && horizontalDist < Math.max(STACKED_HORIZONTAL_GAP, Math.min(radius, existing.radius) * 0.95)) {
        return true;
      }
    }
    return false;
  }

  private findGearPlacement(input: {
    band: DifficultyBand;
    context: PlacementContext;
    currentAngle: number;
    radius: number;
    targetY: number;
  }): PlacementResult | null {
    const anchors = this.getPlacementAnchors(input.targetY, input.context, input.currentAngle);
    if (anchors.length === 0) {
      return null;
    }

    const idealDistance = lerp(input.band.distanceMin, input.band.distanceMax, 0.52);
    const preferredStep = input.context === "challenge"
      ? 0.7
      : (input.context === "milestone" ? 0.55 : 0.82);

    let best: PlacementResult | null = null;
    for (const anchor of anchors) {
      const anchorAngle = Math.atan2(anchor.z, anchor.x);
      const anchorDistance = Math.hypot(anchor.x, anchor.z);
      const preferredSign = signedAngleDelta(input.currentAngle, anchorAngle) >= 0 ? 1 : -1;
      const signOptions = [preferredSign, -preferredSign] as const;
      const swingOptions = input.context === "challenge"
        ? [0.42, 0.68, 0.92]
        : (input.context === "milestone" ? [0.72, 0.98, 1.22] : [0.52, 0.78, 1.02]);
      const stepOptions = input.context === "challenge"
        ? [0.85, 1.0, 1.12]
        : (input.context === "milestone" ? [1.25, 1.55, 1.85] : [0.9, 1.0, 1.14]);
      const minAnchorSpacing = Math.max(input.band.distanceMin * 0.9, (anchor.radius + input.radius) * 0.52);
      const maxAnchorSpacing = Math.min(
        input.context === "milestone" ? 6.2 : 5.1,
        input.band.distanceMax + (anchor.radius + input.radius) * (input.context === "challenge" ? 0.55 : 0.48),
      );

      for (const sign of signOptions) {
        for (const swing of swingOptions) {
          for (const stepScale of stepOptions) {
            const orbitBaseAngle = anchorDistance > 0.45 ? anchorAngle : input.currentAngle;
            const candidateAngle = normalizeRadians(orbitBaseAngle + sign * swing + this.randomRange(-0.1, 0.1));
            const anchorStep = clamp(
              idealDistance * stepScale + this.randomRange(-0.22, 0.22),
              minAnchorSpacing,
              maxAnchorSpacing,
            );

            let candidateX = anchor.x + Math.cos(candidateAngle) * anchorStep;
            let candidateZ = anchor.z + Math.sin(candidateAngle) * anchorStep;
            let towerDistance = Math.hypot(candidateX, candidateZ);
            if (towerDistance < 1.45) {
              const scale = 1.45 / Math.max(towerDistance, 0.001);
              candidateX *= scale;
              candidateZ *= scale;
              towerDistance = 1.45;
            }
            const maxTowerDistance = Math.max(4.3, input.band.distanceMax + (input.context === "challenge" ? 1.1 : 0.9));
            if (towerDistance > maxTowerDistance) {
              const scale = maxTowerDistance / towerDistance;
              candidateX *= scale;
              candidateZ *= scale;
              towerDistance = maxTowerDistance;
            }
            const clearanceScore = this.getPlacementClearanceScore(candidateX, input.targetY, candidateZ, input.radius);
            if (clearanceScore === -Infinity) {
              continue;
            }

            const dx = candidateX - anchor.x;
            const dz = candidateZ - anchor.z;
            const horizontalDistance = Math.hypot(dx, dz);
            const verticalDistance = input.targetY - anchor.y;
            const playableGap = horizontalDistance - anchor.radius - input.radius;
            const basePlayableGap = input.context === "challenge" ? 2.9 : 2.65;
            const maxPlayableGap = this.getMaxPlayableGap(anchor.rotationSpeed, input.band, basePlayableGap);
            const minHorizontalReach = Math.max(1.0, minAnchorSpacing * 0.9);
            if (
              verticalDistance > MAX_ROUTE_VERTICAL_STEP
              || horizontalDistance < minHorizontalReach
              || horizontalDistance > maxAnchorSpacing
              || playableGap > maxPlayableGap
            ) {
              continue;
            }

            const idealPlayableGap = input.context === "milestone" ? 1.45 : (input.context === "challenge" ? 1.2 : 0.95);
            const distanceScore = 1 - Math.abs(playableGap - idealPlayableGap) / 1.8;
            const stepScore = 1 - Math.abs(swing - preferredStep);
            const orbitProgress = 1 - Math.abs(Math.abs(signedAngleDelta(candidateAngle, anchorAngle)) - preferredStep);
            const laneBias = towerDistance > 1.55 ? 0.2 : -0.4;
            const score = clearanceScore + distanceScore * 1.8 + stepScore + orbitProgress * 0.8 + laneBias;
            if (!best || score > best.score) {
              best = {
                angle: candidateAngle,
                anchorId: anchor.id,
                score,
                x: candidateX,
                z: candidateZ,
              };
            }
          }
        }
      }
    }

    if (best) {
      return best;
    }

    const fallbackDistance = clamp(
      anchors.reduce((sum, anchor) => sum + Math.hypot(anchor.x, anchor.z), 0) / anchors.length,
      1.45,
      Math.max(4.2, input.band.distanceMax + 0.4),
    );
    const fallbackOffsets = [0.48, 0.72, 0.96, 1.2, -0.48, -0.72, -0.96, -1.2];
    for (const offset of fallbackOffsets) {
      const candidateAngle = normalizeRadians(input.currentAngle + offset);
      const candidateX = Math.cos(candidateAngle) * fallbackDistance;
      const candidateZ = Math.sin(candidateAngle) * fallbackDistance;
      const clearanceScore = this.getPlacementClearanceScore(candidateX, input.targetY, candidateZ, input.radius);
      if (clearanceScore === -Infinity) {
        continue;
      }
      const hasReachableAnchor = anchors.some((anchor) => {
        const dx = candidateX - anchor.x;
        const dz = candidateZ - anchor.z;
        const horizontalDistance = Math.hypot(dx, dz);
        const playableGap = horizontalDistance - anchor.radius - input.radius;
        const maxPlayableGap = this.getMaxPlayableGap(anchor.rotationSpeed, getDifficultyBand(input.targetY), 2.8);
        return input.targetY - anchor.y <= MAX_ROUTE_VERTICAL_STEP && playableGap <= maxPlayableGap && horizontalDistance >= 1.05 && horizontalDistance <= 5.0;
      });
      if (!hasReachableAnchor) {
        continue;
      }
      return {
        angle: candidateAngle,
        anchorId: anchors[0]?.id ?? null,
        score: clearanceScore,
        x: candidateX,
        z: candidateZ,
      };
    }

    return this.findSweptPlacement(input);
  }

  private getPlacementAnchors(targetY: number, context: PlacementContext, currentAngle: number): SimGear[] {
    const preferredChallenge = context === "challenge";
    const minY = targetY - PATH_ANCHOR_WINDOW;
    return this.state.gears
      .filter((gear) => gear.active && gear.y < targetY - 0.4 && gear.y >= minY)
      .sort((a, b) => {
        const aChallengeBias = preferredChallenge === a.challenge ? 0 : 2.5;
        const bChallengeBias = preferredChallenge === b.challenge ? 0 : 2.5;
        const aVertical = Math.abs((targetY - a.y) - 2.5);
        const bVertical = Math.abs((targetY - b.y) - 2.5);
        const aAngle = Math.abs(signedAngleDelta(currentAngle, Math.atan2(a.z, a.x)));
        const bAngle = Math.abs(signedAngleDelta(currentAngle, Math.atan2(b.z, b.x)));
        return (aChallengeBias + aVertical + aAngle * 0.6) - (bChallengeBias + bVertical + bAngle * 0.6);
      })
      .slice(0, context === "challenge" ? 7 : 6);
  }

  private getPlacementClearanceScore(x: number, y: number, z: number, radius: number): number {
    let minScore = Infinity;
    for (const existing of this.state.gears) {
      const dx = x - existing.x;
      const dz = z - existing.z;
      const dy = Math.abs(y - existing.y);
      const horizontalDist = Math.hypot(dx, dz);
      const overlapThreshold = (radius + existing.radius) * 1.18;
      const stackedThreshold = Math.max(STACKED_HORIZONTAL_GAP, Math.min(radius, existing.radius) * 0.95);
      if (dy < NORMAL_CLEARANCE_VERTICAL_WINDOW && horizontalDist < overlapThreshold) {
        return -Infinity;
      }
      if (dy < STACKED_VERTICAL_WINDOW && horizontalDist < stackedThreshold) {
        return -Infinity;
      }

      const verticalPenaltyWindow = dy < 4 ? 1 : 0;
      if (verticalPenaltyWindow) {
        const clearance = horizontalDist - (radius + existing.radius) * 0.9;
        minScore = Math.min(minScore, clearance);
      }
    }

    return minScore === Infinity ? 5 : minScore;
  }

  private getRecentChallengeAnchor(centerY: number): SimGear | null {
    for (let index = this.state.gears.length - 1; index >= 0; index -= 1) {
      const gear = this.state.gears[index];
      if (!gear.challenge) {
        continue;
      }
      if (Math.abs(gear.y - centerY) <= 10) {
        return gear;
      }
    }
    return null;
  }

  private findSweptPlacement(input: {
    context: PlacementContext;
    currentAngle: number;
    radius: number;
    targetY: number;
  }): PlacementResult | null {
    const anchors = this.getPlacementAnchors(input.targetY, input.context, input.currentAngle);
    const angleOffsets = input.context === "milestone"
      ? [
          0.55, -0.55, 0.95, -0.95, 1.35, -1.35, 1.75, -1.75,
          2.15, -2.15, 2.55, -2.55, 2.95, -2.95,
        ]
      : [0.55, 0.85, 1.15, 1.45, -0.55, -0.85, -1.15, -1.45];
    const distanceOptions = input.context === "milestone"
      ? [3.8, 4.4, 5.0, 5.6]
      : (input.context === "challenge" ? [2.6, 3.2, 3.8, 4.4] : [2.8, 3.4, 4.0, 4.6]);

    for (const offset of angleOffsets) {
      for (const distance of distanceOptions) {
        const angle = normalizeRadians(input.currentAngle + offset);
        const x = Math.cos(angle) * distance;
        const z = Math.sin(angle) * distance;
        if (this.getPlacementClearanceScore(x, input.targetY, z, input.radius) === -Infinity) {
          continue;
        }
        const reachable = anchors.some((anchor) => {
          const horizontalDistance = Math.hypot(x - anchor.x, z - anchor.z);
          const playableGap = horizontalDistance - anchor.radius - input.radius;
          return input.targetY - anchor.y <= MAX_ROUTE_VERTICAL_STEP && playableGap >= 0.15 && playableGap <= 2.8;
        });
        if (!reachable) {
          continue;
        }
        return {
          angle,
          anchorId: anchors[0]?.id ?? null,
          score: distance,
          x,
          z,
        };
      }
    }

    return null;
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
        gear.windAngle += dt * 0.2; // Slowly rotate wind direction
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

      const impactSpeed = player.vy;
      const gearBottom = gear.y - gear.height / 2 - gear.crumbleFallDistance;
      player.y = block.capY;
      player.vy = 0;
      this.events.push({
        type: "gear_block",
        gearId: gear.id,
        x: gear.x,
        y: gearBottom - 0.04,
        z: gear.z,
        impactSpeed,
      });
      break;
    }
  }

  private advancePlayer(action: SimAction, dt: number) {
    const player = this.state.player;
    player.prevY = player.y;
    player.speedBoostTimer = Math.max(0, player.speedBoostTimer - dt);
    player.boltMagnetTimer = Math.max(0, player.boltMagnetTimer - dt);
    player.slowMoTimer = Math.max(0, player.slowMoTimer - dt);
    player.doubleJumpTimer = Math.max(0, player.doubleJumpTimer - dt);
    if (player.doubleJumpTimer === 0) {
      player.doubleJumpAvailable = false;
    }

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
    } else if (!player.onGround && player.doubleJumpAvailable && action.jump) {
      player.vy = JUMP_VELOCITY;
      player.doubleJumpAvailable = false;
      player.doubleJumpTimer = 0;
      this.events.push({ type: "double_jump", x: player.x, y: player.y, z: player.z });
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
        case "double_jump":
          player.doubleJumpAvailable = true;
          player.doubleJumpTimer = DOUBLE_JUMP_DURATION;
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
      this.state.player.doubleJumpAvailable = false;
      this.state.player.doubleJumpTimer = 0;
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

function normalizeRadians(value: number): number {
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function signedAngleDelta(a: number, b: number): number {
  return normalizeRadians(a - b);
}

function normalizeAngle(value: number): number {
  return normalizeRadians(value) / Math.PI;
}
