export type Vec3 = { x: number; y: number; z: number };

export type SimAction = {
  moveX: number;
  moveY: number;
  jump: boolean;
};

export type GearVariant = "normal" | "crumbling" | "speed" | "reverse" | "piston";

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
};

export type SimBolt = {
  id: number;
  gearId: number;
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
};

export type SimState = {
  gameState: "title" | "playing" | "dying" | "gameover";
  player: SimPlayer;
  gears: SimGear[];
  bolts: SimBolt[];
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
  | { type: "gear_block" }
  | { type: "zone_change"; zoneIndex: number }
  | { type: "achievement"; id: string };
