export type Vec3 = { x: number; y: number; z: number };

export type SimAction = {
  moveX: number;
  moveY: number;
  jump: boolean;
};

export type GearVariant = "normal" | "crumbling" | "speed" | "reverse" | "piston" | "wind" | "magnetic" | "bouncy" | "milestone";

export type SimGear = {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  rotationSpeed: number;
  rotationDir: number;
  variant: GearVariant;
  active: boolean;
  currentRotation: number;
  crumbleArmed: boolean;
  crumbleTimer: number;
  crumbleFallVelocity: number;
  crumbleFallDistance: number;
  reverseTimer: number;
  reverseInterval: number;
  reversePause: number;
  pistonTime: number;
  windAngle: number;
  windStrength: number;
  challenge: boolean;
  /** Sim elapsed time when this gear was created. -Infinity for boot gears (no fade). */
  spawnTime: number;
};

export type SimBolt = {
  id: number;
  gearId: number;
  x: number;
  y: number;
  z: number;
  available: boolean;
};

export type SimPowerUp = {
  id: number;
  gearId: number;
  type: "bolt_magnet" | "slow_mo" | "shield" | "double_jump" | "gear_freeze";
  x: number;
  y: number;
  z: number;
  available: boolean;
};

export type SimPlayer = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  highestY: number;
  prevY: number;
  speedBoostTimer: number;
  speedBoostStrength: number;
  boltMagnetTimer: number;
  slowMoTimer: number;
  shieldCount: number;
  doubleJumpCharges: number;
  gearFreezeTimer: number;
  lastLandedGearX: number;
  lastLandedGearY: number;
  lastLandedGearZ: number;
  /** Position of the last NON-crumbling gear the player landed on.
   *  Shield revive uses this so a chain of crumbling gears doesn't
   *  drop the player back onto a collapsed surface (universal polish
   *  rule 6 — death+revive must not loop). Updated only when the gear
   *  variant is something the player can stand on indefinitely. */
  lastStableGearX: number;
  lastStableGearY: number;
  lastStableGearZ: number;
};

export type SimState = {
  gameState: "title" | "playing" | "dying" | "gameover";
  player: SimPlayer;
  gears: SimGear[];
  bolts: SimBolt[];
  powerUps: SimPowerUp[];
  score: number;
  heightScore: number;
  heightMaxReached: number;
  boltCount: number;
  boltScore: number;
  comboLandings: number;
  comboMultiplier: number;
  bestCombo: number;
  gameTime: number;
  elapsedTime: number;
  activeGearId: number | null;
  orbitAngle: number;
  nextMilestone: number;
  currentZoneIndex: number;
  inChallengeZone: boolean;
  challengeZoneCenter: number;
  windGearCount: number;
  bouncyGearCount: number;
  powerUpCount: number;
  completedChallengeZones: number;
  shieldSaveCount: number;
  airBoltChain: number;
  bestAirBoltChain: number;
};

export type SimEvent =
  | { type: "gear_land"; gearId: number; variant: GearVariant; landingSpeed: number; nearMiss: boolean; x: number; y: number; z: number }
  | { type: "bolt_collect"; boltId: number; totalBolts: number; x: number; y: number; z: number }
  | { type: "combo_up"; multiplier: number }
  | { type: "combo_break" }
  | { type: "milestone"; height: number; nextMilestone: number }
  | { type: "piston_launch"; x: number; y: number; z: number }
  | { type: "speed_boost"; x: number; y: number; z: number }
  | { type: "death_start" }
  | { type: "death" }
  | { type: "jump"; x: number; y: number; z: number }
  | { type: "double_jump"; x: number; y: number; z: number; remaining: number }
  | { type: "gear_block"; gearId: number; x: number; y: number; z: number; impactSpeed: number }
  | { type: "zone_change"; zoneIndex: number }
  | { type: "achievement"; id: string }
  | { type: "bounce_jump"; x: number; y: number; z: number; gearId: number }
  | { type: "powerup_collect"; powerUpType: "bolt_magnet" | "slow_mo" | "shield" | "double_jump" | "gear_freeze"; x: number; y: number; z: number }
  | { type: "shield_save"; x: number; y: number; z: number; shieldCountRemaining: number }
  | { type: "challenge_zone_enter"; zoneCenter: number }
  | { type: "challenge_zone_exit"; bonusScore: number }
  | { type: "gear_freeze_start" }
  | { type: "gear_freeze_end" };
