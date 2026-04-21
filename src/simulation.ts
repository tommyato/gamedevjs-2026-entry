import type { GearVariant, SimAction, SimBolt, SimEvent, SimGear, SimPlayer, SimState } from "./sim-types";

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
  private readonly initialSeed: number;
  private readonly fixedDt: number | null;

  private rng: () => number;
  private state: SimState;
  private events: SimEvent[] = [];
  private gearIdCounter = 0;
  private boltIdCounter = 0;
  private generationHeight = 0;
  private generationAngle = 0;
  private cleanupTimer = 0;
  private timeSinceLastLanding = Infinity;
  private readonly recentComboGearIds = new Set<number>();
  private readonly unlockedThisRun = new Set<string>();
  private orbitAngleTarget = Math.PI / 2;
  private cameraY = 8.1;
  private deathFreezeTimer = 0;

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
    this.generationHeight = 0;
    this.generationAngle = 0;
    this.cleanupTimer = 0;
    this.timeSinceLastLanding = Infinity;
    this.recentComboGearIds.clear();
    this.unlockedThisRun.clear();
    this.orbitAngleTarget = Math.PI / 2;
    this.cameraY = 8.1;
    this.deathFreezeTimer = 0;
    this.state = this.createInitialState();
    this.state.gameState = "playing";
    this.seedInitialLayout();
    this.updateBoltPositions();
    return this.flush();
  }

  step(action: SimAction, dt?: number): { state: SimState; events: SimEvent[] } {
    const stepDt = this.fixedDt ?? (Number.isFinite(dt) ? Number(dt) : DEFAULT_FIXED_DT);
    if (stepDt <= 0) {
      return this.flush();
    }

    if (this.state.gameState === "gameover" || this.state.gameState === "title") {
      return this.flush();
    }

    if (this.state.gameState === "dying") {
      this.advanceDying(stepDt);
      return this.flush();
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
    this.advancePlayer(action, stepDt);
    this.handlePoleCollision();
    this.updateBoltPositions();
    this.handleBoltCollection();
    this.updateOrbit(stepDt);
    this.updateScores();
    this.updateZone();
    this.cleanupTimer += stepDt;
    if (this.cleanupTimer >= 2) {
      this.cleanupTimer = 0;
      this.cleanupBelow();
    }
    this.checkAchievements();
    this.checkDeath();

    return this.flush();
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
    };

    return {
      gameState: "title",
      player,
      gears: [],
      bolts: [],
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
      const radius = this.randomRange(band.radiusMin, band.radiusMax);
      const distance = this.randomRange(band.distanceMin, band.distanceMax);
      const variant = this.pickGearVariant(height);
      const gear = this.createGear({
        x: Math.cos(angle) * distance,
        y: height,
        z: Math.sin(angle) * distance,
        radius,
        height: 0.3,
        rotationSpeed: this.randomRange(band.rotationMin, band.rotationMax),
        variant,
      });
      this.state.gears.push(gear);
      this.trySpawnBolt(gear);
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

  private trySpawnBolt(gear: SimGear) {
    if (gear.variant === "crumbling" || this.rng() >= 0.3) {
      return;
    }
    this.state.bolts.push(this.createBolt(gear));
  }

  private generateAhead() {
    let height = this.generationHeight;
    let angle = this.generationAngle;
    let batchesGenerated = 0;

    while (height - this.state.heightMaxReached <= 40 && batchesGenerated < 5) {
      for (let index = 0; index < 10; index += 1) {
        const band = getDifficultyBand(height);
        height += this.randomRange(band.verticalMin, band.verticalMax);
        angle += this.randomRange(0.75, 1.75);
        const radius = this.randomRange(band.radiusMin, band.radiusMax);
        const distance = this.randomRange(band.distanceMin, band.distanceMax);
        const variant = this.pickGearVariant(height);
        const gear = this.createGear({
          x: Math.cos(angle) * distance,
          y: height,
          z: Math.sin(angle) * distance,
          radius,
          height: 0.3,
          rotationSpeed: this.randomRange(band.rotationMin, band.rotationMax),
          variant,
        });
        this.state.gears.push(gear);
        this.trySpawnBolt(gear);
      }
      batchesGenerated += 1;
    }

    this.generationHeight = height;
    this.generationAngle = angle;
  }

  private pickGearVariant(height: number): GearVariant {
    if (height >= 55 && this.rng() < 0.15) {
      return "piston";
    }
    const roll = this.rng();
    if (height >= 75 && roll < 0.22) {
      return "reverse";
    }
    if (height >= 45 && roll < 0.38) {
      return "speed";
    }
    if (height >= 30 && roll < 0.54) {
      return "crumbling";
    }
    return "normal";
  }

  private updateGears(dt: number) {
    for (const gear of this.state.gears) {
      if (gear.variant === "piston") {
        gear.pistonTime += dt;
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

    if (!player.onGround) {
      player.vy -= GRAVITY * dt;
    } else {
      player.vy = 0;
    }

    if (player.onGround && action.jump) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      this.events.push({ type: "jump", x: player.x, y: player.y, z: player.z });
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

  private handleBoltCollection() {
    const player = this.state.player;
    for (const bolt of this.state.bolts) {
      if (!bolt.available) {
        continue;
      }

      const dx = player.x - bolt.x;
      const dy = player.y + 0.3 - bolt.y;
      const dz = player.z - bolt.z;
      if (dx * dx + dy * dy + dz * dz > 0.75 * 0.75) {
        continue;
      }

      bolt.available = false;
      this.state.boltCount += 1;
      this.state.boltScore += BOLT_SCORE_VALUE;
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

  private updateOrbit(dt: number) {
    const player = this.state.player;
    const verticalLead = clamp(player.vy * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (player.onGround ? 5.5 : 4));
    const orbitLerp = 1 - Math.exp(-dt * 7);

    if (player.onGround) {
      const heightOrbitBias = player.y * (Math.PI / 2) / 40;
      const playerDist = Math.hypot(player.x, player.z);
      const baseAngle = heightOrbitBias + (playerDist > 0.5 ? Math.atan2(player.z, player.x) : 0);
      let nudge = 0;
      const maxNudge = 1.3;
      const nudgeStep = 0.05;
      const angleTolerance = 0.18;
      const verticalWindow = 3;

      for (let step = 0; step <= maxNudge / nudgeStep; step += 1) {
        const testAngle = baseAngle + nudge;
        const camX = Math.cos(testAngle) * ORBIT_RADIUS;
        const camZ = Math.sin(testAngle) * ORBIT_RADIUS;
        const toPlayerX = player.x - camX;
        const toPlayerZ = player.z - camZ;
        const toPlayerLen = Math.hypot(toPlayerX, toPlayerZ) || 1;
        const camToPlayerAngle = Math.atan2(toPlayerZ, toPlayerX);

        let clear = true;
        for (const gear of this.state.gears) {
          if (gear.id === this.state.activeGearId) {
            continue;
          }
          if (Math.abs(gear.y - player.y) > verticalWindow) {
            continue;
          }
          const toGearX = gear.x - camX;
          const toGearZ = gear.z - camZ;
          const toGearLen = Math.hypot(toGearX, toGearZ) || 1;
          if (toGearLen >= toPlayerLen) {
            continue;
          }
          const camToGearAngle = Math.atan2(toGearZ, toGearX);
          let angleDelta = camToGearAngle - camToPlayerAngle;
          while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
          while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
          const gearAngularHalf = Math.atan2(gear.radius, toGearLen);
          if (Math.abs(angleDelta) < angleTolerance + gearAngularHalf) {
            clear = false;
            break;
          }
        }

        if (clear) {
          break;
        }
        nudge = Math.min(nudge + nudgeStep, maxNudge);
      }

      this.orbitAngleTarget = baseAngle + nudge;
    }

    let angleDiff = this.orbitAngleTarget - this.state.orbitAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    this.state.orbitAngle += angleDiff * orbitLerp;

    const targetCamY = player.y + 6.1 + verticalLead;
    this.cameraY = lerp(this.cameraY, targetCamY, followLerp);
  }

  private updateScores() {
    const currentHeight = Math.max(0, Math.floor(this.state.player.y));
    const previousReached = this.state.heightMaxReached;
    if (currentHeight > this.state.heightMaxReached) {
      const delta = currentHeight - this.state.heightMaxReached;
      this.state.heightMaxReached = currentHeight;
      this.state.heightScore += delta * this.state.comboMultiplier;
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
    maybeUnlock("ENDURANCE", this.state.gameTime >= 60);
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
  }

  private checkDeath() {
    if (this.state.player.y < this.cameraY - 12 && this.state.gameState === "playing") {
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
      danger: 0.28,
      distanceMax: 2.8,
      distanceMin: 1.8,
      radiusMax: 2.35,
      radiusMin: 1.5,
      rotationMax: 0.95,
      rotationMin: 0.58,
      verticalMax: 2.6,
      verticalMin: 2.25,
    };
  }
  if (height < 75) {
    return {
      danger: 0.58,
      distanceMax: 3.25,
      distanceMin: 2.2,
      radiusMax: 1.9,
      radiusMin: 1.2,
      rotationMax: 1.5,
      rotationMin: 0.95,
      verticalMax: 2.8,
      verticalMin: 2.35,
    };
  }
  return {
    danger: 0.9,
    distanceMax: 3.6,
    distanceMin: 2.5,
    radiusMax: 1.55,
    radiusMin: 1.02,
    rotationMax: 2.05,
    rotationMin: 1.3,
    verticalMax: 2.9,
    verticalMin: 2.4,
  };
}

function getZoneIndex(height: number): number {
  if (height >= 75) return 3;
  if (height >= 50) return 2;
  if (height >= 25) return 1;
  return 0;
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
