import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  getAudioEnabled,
  initAudio,
  playAchievementUnlock,
  playBouncyGearBounce,
  playClick,
  playCollect,
  playComboLand,
  playCrumbleGearCrack,
  playGearBonk,
  playGearTick,
  playHit,
  playJump,
  playLand,
  playMagnetPulse,
  playMilestone,
  playPistonLaunch,
  playRankRevealNeutral,
  playRankRevealVictory,
  playSteamHiss,
  playTone,
  playWindGust,
  setAudioEnabled,
  setMusicIntensity,
  setTickRate,
  startAmbientTick,
  startMusic,
  stopAmbientTick,
  stopMusic,
  toggleAudio,
} from "./audio";
import { BoltCollectible } from "./bolt";
import { Gear } from "./gear";
import { GearPool } from "./gear-pool";
import { Input } from "./input";
import { ParticleSystem } from "./particles";
import {
  fetchLeaderboardScores,
  getStat,
  getUsername,
  isAudioEnabled,
  listAchievementProgress,
  loadSaveData,
  onAudioChange,
  platformInit,
  requestStats,
  registerPauseHandlers,
  signalFirstFrame,
  signalGameReady,
  signalLoadComplete,
  storeStats,
  submitDailyScore,
  submitScores,
  unlockAchievement,
  updateStat,
  writeSaveData,
} from "./platform";
import type { AchievementProgress } from "./platform";
import { AIGhost, getAIGhostModelUrl, isAIGhostEnabled } from "./ai-ghost";
import {
  CHALLENGE_SEED,
  GhostRecorder,
  type GhostRecord,
} from "./ghost-recorder";
import { GhostPlayback } from "./ghost-playback";
import {
  fetchGhosts as fetchRemoteGhosts,
  fetchGhostUploadThreshold,
  submitGhost as submitRemoteGhost,
  pickRandom as pickRandomGhost,
} from "./remote-ghosts";
import { getLocalUsername as getCoolLocalUsername, setLocalUsername as setCoolLocalUsername } from "./coolname";
import { MultiplayerManager, type MatchResult, type PeerGhost } from "./multiplayer";
import { Player } from "./player";
import { applyTopDownShadowToObject, TopDownShadowSystem } from "./shadow";
import { ClockworkClimbSimulation } from "./simulation";
import type { GearVariant, SimAction, SimBolt, SimEvent, SimGear, SimPlayer, SimPowerUp, SimState } from "./sim-types";

const GHOST_COLORS = [0x00ddff, 0xff00dd, 0x00ff88, 0xff8800];

type GhostVisual = {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyMaterial: THREE.MeshStandardMaterial;
  eyes: THREE.Mesh[];
  label: HTMLDivElement;
  colorHex: number;
};

enum GameState {
  Title,
  Playing,
  GameOver,
  Paused,
}

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

type BackgroundDecoration = {
  mesh: THREE.Object3D;
  rotationSpeed: number;
};

type TitleBackdropDecoration = {
  baseY: number;
  bobAmplitude: number;
  bobPhase: number;
  gear: Gear;
  mesh: THREE.Object3D;
  rotationSpeed: number;
};

type CameraDistancePulse = {
  amount: number;
  attack: number;
  elapsed: number;
  release: number;
};

type ScorePop = {
  element: HTMLDivElement;
  age: number;
  duration: number;
  left: number;
  top: number;
  value: number;
};

type SaveData = {
  bestScore: number;
  bestHeight: number;
  bestCombo: number;
  totalRuns: number;
  totalBolts: number;
  totalPlaytime: number;
  audioEnabled: boolean;
};

type LeaderboardDisplayEntry = {
  username: string;
  score: number;
  rank: number;
};

type AchievementCatalogEntry = {
  id: string;
  title: string;
  description: string;
};

const DEFAULT_SAVE_DATA: SaveData = {
  bestScore: 0,
  bestHeight: 0,
  bestCombo: 1,
  totalRuns: 0,
  totalBolts: 0,
  totalPlaytime: 0,
  audioEnabled: true,
};

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// "2026-04-22" → "April 22nd, 2026". Uses UTC so every player sees the same
// label for a given daily seed, regardless of local timezone.
const DAILY_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function dayOrdinalSuffix(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
function formatHumanDate(dateKey: string): string {
  // dateKey is "YYYY-MM-DD" from utcDateKey(). Parse as UTC, not local.
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return dateKey;
  const monthName = DAILY_MONTH_NAMES[month - 1] ?? parts[1];
  return `${monthName} ${day}${dayOrdinalSuffix(day)}, ${year}`;
}

function dailySeed(dateKey = utcDateKey()): number {
  return fnv1a(`clockwork-climb-${dateKey}`);
}

function dailyBestStorageKey(dateKey: string): string {
  return `clockwork-daily-best-${dateKey}`;
}

function getUtcMsUntilTomorrow(date = new Date()): number {
  const nextMidnightUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(0, nextMidnightUtc - date.getTime());
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// -------------------------------------------------------------------------
// Run Contracts — per-run mini-challenges that award a score bonus on
// completion. Three are rolled at the start of each non-daily run and shown
// live in the HUD. Defs are pure — progress is computed from the sim state
// plus a handful of run-local counters tracked on the Game class.
// -------------------------------------------------------------------------

type ContractCtx = {
  state: SimState;
  nearMisses: number;
  powerupsCollected: number;
  // Seconds since the last shield_save event (or since run start if never).
  timeSinceLastShieldBreak: number;
  runTime: number;
};

type ContractDef = {
  readonly id: string;
  readonly label: string;
  readonly target: number;
  readonly reward: number;
  // Category tag — prevents a single roll from picking two contracts that
  // track the same thing (e.g. both "collect 15 bolts" and "collect 30 bolts").
  readonly category: string;
  // Returns current (unclamped) progress value in the same unit as `target`.
  readonly progress: (ctx: ContractCtx) => number;
  // Optional custom progress text (e.g. "12/50m"); defaults to "n/target".
  readonly format?: (progress: number, target: number) => string;
};

type ContractInstance = {
  def: ContractDef;
  progress: number;
  complete: boolean;
  celebrateTimer: number;
};

const CONTRACT_POOL: readonly ContractDef[] = [
  {
    id: "reach-50",
    label: "Reach 50m",
    target: 50,
    reward: 500,
    category: "reach",
    progress: (ctx) => ctx.state.heightMaxReached,
    format: (p, t) => `${Math.min(Math.floor(p), t)}/${t}m`,
  },
  {
    id: "reach-100",
    label: "Reach 100m",
    target: 100,
    reward: 1000,
    category: "reach",
    progress: (ctx) => ctx.state.heightMaxReached,
    format: (p, t) => `${Math.min(Math.floor(p), t)}/${t}m`,
  },
  {
    id: "collect-15",
    label: "Collect 15 bolts",
    target: 15,
    reward: 400,
    category: "collect",
    progress: (ctx) => ctx.state.boltCount,
  },
  {
    id: "collect-30",
    label: "Collect 30 bolts",
    target: 30,
    reward: 800,
    category: "collect",
    progress: (ctx) => ctx.state.boltCount,
  },
  {
    id: "combo-5",
    label: "Hit a 5x combo",
    target: 5,
    reward: 500,
    category: "combo",
    progress: (ctx) => ctx.state.bestCombo,
    format: (p, t) => `x${Math.min(Math.floor(p), t)}/x${t}`,
  },
  {
    id: "combo-8",
    label: "Hit an 8x combo",
    target: 8,
    reward: 1000,
    category: "combo",
    progress: (ctx) => ctx.state.bestCombo,
    format: (p, t) => `x${Math.min(Math.floor(p), t)}/x${t}`,
  },
  {
    id: "near-miss-5",
    label: "Land 5 near-misses",
    target: 5,
    reward: 600,
    category: "near-miss",
    progress: (ctx) => ctx.nearMisses,
  },
  {
    id: "survive-60",
    label: "Survive 60s",
    target: 60,
    reward: 500,
    category: "survive",
    progress: (ctx) => ctx.runTime,
    format: (p, t) => `${Math.min(Math.floor(p), t)}/${t}s`,
  },
  {
    id: "no-shield-break-45",
    label: "Survive 45s without a shield break",
    target: 45,
    reward: 700,
    category: "no-shield-break",
    progress: (ctx) => ctx.timeSinceLastShieldBreak,
    format: (p, t) => `${Math.min(Math.floor(p), t)}/${t}s`,
  },
  {
    id: "air-bolt-chain-3",
    label: "Chain 3 air bolts",
    target: 3,
    reward: 500,
    category: "air-bolt-chain",
    progress: (ctx) => ctx.state.bestAirBoltChain,
  },
  {
    id: "challenge-zone-1",
    label: "Clear 1 Challenge Zone",
    target: 1,
    reward: 600,
    category: "challenge-zone",
    progress: (ctx) => ctx.state.completedChallengeZones,
  },
  {
    id: "powerups-3",
    label: "Collect 3 power-ups",
    target: 3,
    reward: 400,
    category: "powerups",
    progress: (ctx) => ctx.powerupsCollected,
  },
];

function pickRandomContracts(count: number): ContractInstance[] {
  // Dedup by category so a single roll can't produce two contracts that
  // track the same thing (e.g. "Collect 15 bolts" and "Collect 30 bolts").
  let pool = [...CONTRACT_POOL];
  const picked: ContractInstance[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    const [def] = pool.splice(idx, 1);
    picked.push({ def, progress: 0, complete: false, celebrateTimer: 0 });
    pool = pool.filter((p) => p.category !== def.category);
  }
  return picked;
}

function formatContractProgress(instance: ContractInstance): string {
  const { def, progress } = instance;
  if (def.format) {
    return def.format(progress, def.target);
  }
  return `${Math.min(Math.floor(progress), def.target)}/${def.target}`;
}

export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private clock = new THREE.Clock();
  private readonly animationLoop = () => this.loop();
  private animationLoopRunning = false;
  private hasRenderedFirstFrame = false;

  private readonly input = new Input();
  private readonly regularSeed = Math.floor(Math.random() * 0x1_0000_0000);
  private readonly sim = new ClockworkClimbSimulation({ seed: this.regularSeed });
  private simState: SimState | null = null;
  private state = GameState.Title;
  private isDailyChallenge = false;
  private dailyChallengeDate = utcDateKey();
  private dailyPreviousBest: number | null = null;
  private score = 0;
  private heightScore = 0;
  private heightMaxReached = 0;
  private boltCount = 0;
  private boltScore = 0;
  private highScore = 0;
  private gameTime = 0;
  private elapsedTime = 0;
  private nextMilestone = 25;
  private currentZoneIndex = 0;
  private bestCombo = 1;
  private runStartElapsedTime = 0;
  private inChallengeZone = false;
  private challengeZoneBloomBoost = 0;
  private saveData: SaveData = { ...DEFAULT_SAVE_DATA };
  private titleLeaderboardEntries: LeaderboardDisplayEntry[] = [];
  private gameOverLeaderboardEntries: LeaderboardDisplayEntry[] = [];

  private hud!: HTMLElement;
  private titleOverlay!: HTMLElement;
  private titleActions!: HTMLElement;
  private hudScore!: HTMLElement;
  private hudBest!: HTMLElement;
  private hudBolts!: HTMLElement;
  private hudStatus!: HTMLElement;
  private hudToast!: HTMLElement;
  private hudControls!: HTMLElement;
  private hudCombo!: HTMLElement;
  private hudDoubleJumpCharges!: HTMLElement;
  private hudShieldCount!: HTMLElement;
  private doubleJumpFlashTimer = 0;
  private shieldFlashTimer = 0;
  private lastDoubleJumpCharges = 0;
  private lastShieldCount = 0;
  private shieldSaveFlashTimer = 0;
  private comboGlowOverlay!: HTMLDivElement;
  private scorePopLayer!: HTMLDivElement;
  private soundToggleBtn!: HTMLElement;
  private pauseOverlay!: HTMLElement;
  private closeCallOverlay!: HTMLElement;
  private shieldSaveOverlay!: HTMLElement;
  private tutorialOverlay!: HTMLElement;
  private tutorialControls!: HTMLElement;
  private tutorialObjective!: HTMLElement;
  private titleHeading!: HTMLElement;
  private titleTagline!: HTMLElement;
  private titleBest!: HTMLElement;
  private titlePrompt!: HTMLElement;
  private gameOverView!: HTMLElement;
  private gameOverCard!: HTMLElement;
  private shareScoreBtn!: HTMLButtonElement;
  private achievementsButton: HTMLButtonElement | null = null;
  private achievementsPanel: HTMLDivElement | null = null;
  private titleBackButton: HTMLButtonElement | null = null;
  private pauseTitleBtn: HTMLButtonElement | null = null;
  private achievementCatalog: AchievementCatalogEntry[] = [];
  // Queue of achievement labels that arrived while the game-over overlay
  // was visible. Queued entries are rendered in the #gameover-unlocks row
  // instead of firing a toast (which would overlap the overlay), and are
  // flushed as toasts when the overlay is dismissed so they can't vanish
  // silently for players who don't glance at the unlocks row.
  private achievementUnlockQueue: string[] = [];
  private gameOverHeightEl!: HTMLElement;
  private gameOverBoltsEl!: HTMLElement;
  private gameOverBoltCountEl!: HTMLElement;
  private gameOverComboEl!: HTMLElement;
  private gameOverTimeEl!: HTMLElement;
  private gameOverTotalEl!: HTMLElement;
  private zoneAnnouncement!: HTMLElement;
  private pauseBtn!: HTMLElement;
  private titleLeaderboardPanel!: HTMLElement;
  private titleLeaderboardContext!: HTMLElement;
  private titleLeaderboardThreshold!: HTMLElement;
  private titleLeaderboardList!: HTMLElement;
  private gameOverLeaderboardPanel!: HTMLElement;
  private gameOverLeaderboardContext!: HTMLElement;
  private gameOverLeaderboardThreshold!: HTMLElement;
  private gameOverLeaderboardList!: HTMLElement;

  private readonly player = new Player();
  private gears: Gear[] = [];
  private bolts: BoltCollectible[] = [];
  private readonly visualGearMap = new Map<number, Gear>();
  private readonly visualBoltMap = new Map<number, BoltCollectible>();
  private readonly visualPowerUpMap = new Map<number, THREE.Mesh>();
  private towerBase!: THREE.Mesh;
  private playerLight!: THREE.PointLight;
  private topDownShadow!: TopDownShadowSystem;
  private gearPool!: GearPool;
  private readonly landingCueGroup = new THREE.Group();
  private readonly landingCueCoreMaterial = new THREE.MeshBasicMaterial({
    color: 0x160e0a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private readonly landingCueRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xcc8844,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private readonly landingCueGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0xd4983a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private readonly landingCueCore = new THREE.Mesh(new THREE.CircleGeometry(0.2, 10), this.landingCueCoreMaterial);
  private readonly landingCueRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.3, 18), this.landingCueRingMaterial);
  private readonly landingCueGlow = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 18), this.landingCueGlowMaterial);
  // Footstep trail removed - replaced with jump/landing particle bursts
  private readonly _trailColorTemp = new THREE.Color();
  private highlightedGearId: number | null = null;
  private hudOverlaySvg: SVGSVGElement | null = null;
  private hudPickupLine: SVGLineElement | null = null;
  private readonly cameraLookTarget = new THREE.Vector3();
  private readonly landingEffectPosition = new THREE.Vector3();
  private readonly steamSpawnPosition = new THREE.Vector3();
  private readonly particles = new ParticleSystem(200);

  private readonly multiplayer = new MultiplayerManager();
  private readonly ghostMeshes: Map<string, GhostVisual> = new Map();
  private readonly ghostGroup = new THREE.Group();
  private aiGhost: AIGhost | null = null;
  private aiGhostEnabled: boolean = isAIGhostEnabled();
  private aiGhostButton: HTMLButtonElement | null = null;
  // PLAY A GHOST — human-recorded playback challenge. Replaces the scripted
  // AI ghost with a translucent playback of a recorded run on a fixed seed.
  private readonly ghostRecorder = new GhostRecorder();
  private ghostChallengeRecord: GhostRecord | null = null;
  private ghostPlayback: GhostPlayback | null = null;
  private isChallengeMode = false;
  private hudAiBadge: HTMLElement | null = null;
  private multiplayerPanel: HTMLDivElement | null = null;
  private multiplayerButton: HTMLButtonElement | null = null;
  private multiplayerStatus: HTMLDivElement | null = null;
  private multiplayerInviteBtn: HTMLButtonElement | null = null;
  private multiplayerStartBtn: HTMLButtonElement | null = null;
  private multiplayerLeaveBtn: HTMLButtonElement | null = null;
  private multiplayerLabelLayer: HTMLDivElement | null = null;
  private multiplayerLobbyVisible = false;
  private multiplayerInviteUrl: string | null = null;
  private multiplayerPlayerList: HTMLDivElement | null = null;
  private multiplayerNameInput: HTMLInputElement | null = null;
  private multiplayerInviteLinkField: HTMLInputElement | null = null;
  private multiplayerNameDebounceHandle: number | null = null;
  private multiplayerPollHandle: number | null = null;
  /** True while the multiplayer countdown is running — gates all player input. */
  private countdownActive = false;
  private multiplayerCountdownOverlay: HTMLDivElement | null = null;
  /** Last integer second rendered to the overlay (prevents per-frame DOM writes). */
  private countdownLastRenderedSec = -1;
  /** setTimeout handle for hiding the overlay ~400 ms after "GO!" appears. */
  private countdownGoTimer: number | null = null;
  /** True after local player crosses 100 m in a multiplayer match (reset each match). */
  private localFinished = false;
  // ── Match timer HUD ────────────────────────────────────────────────────────
  private matchTimerOverlay: HTMLDivElement | null = null;
  /** Last integer second rendered; prevents per-frame DOM writes. */
  private matchTimerLastRenderedSec = -1;
  /** Whether the warning-entry tick has fired for this match. */
  private matchTimerWarningPlayed = false;
  /** Last critical second for which a rising-pitch tick played. */
  private matchTimerCriticalLastSec = -1;
  // ── End screen ────────────────────────────────────────────────────────────
  private endScreenOverlay: HTMLDivElement | null = null;
  private readonly ghostTmpVec = new THREE.Vector3();
  private readonly backgroundGroup = new THREE.Group();
  private readonly titleBackdropGroup = new THREE.Group();
  private backgroundDecorations: BackgroundDecoration[] = [];
  private titleBackdropDecorations: TitleBackdropDecoration[] = [];
  private readonly gearTickNextTimes = new Map<number, number>();
  // Per-gear squash animation time (seconds since landing) for bouncy gears.
  private readonly bouncyGearSquashTimers = new Map<number, number>();

  // Biome skydome — animated noise sphere following camera (world-anchored, not screen-locked)
  private skydomeMesh: THREE.Mesh | null = null;
  private skydomeShaderMat: THREE.ShaderMaterial | null = null;
  private skydomeFromScrollSpeed = 1.0;
  private skydomeToScrollSpeed = 1.0;
  private skydomeCurrentScrollSpeed = 1.0;
  private skydomeFromPulseFreq = 0.0;
  private skydomeToPulseFreq = 0.0;
  private skydomeCurrentPulseFreq = 0.0;
  private skydomeLerpStart = -10;

  // Biome ambient bokeh particles — drift upward, color/speed per biome
  private biomeParticles: THREE.Points | null = null;
  private biomeParticleGeo: THREE.BufferGeometry | null = null;
  private readonly biomeParticlePositions = new Float32Array(150 * 3);
  private readonly biomeParticleSpeeds = new Float32Array(150);
  private readonly biomeParticleCurrentColor = new THREE.Color(0xff5010);
  private readonly biomeParticleFromColor = new THREE.Color(0xff5010);
  private readonly biomeParticleToColor = new THREE.Color(0xff5010);
  private biomeParticleLerpStart = -10;
  private biomeParticleFromOpacity = 0.30;
  private biomeParticleToOpacity = 0.30;
  private biomeParticleCurrentOpacity = 0.30;
  private biomeParticleFromSpeed = 1.3;
  private biomeParticleToSpeed = 1.3;
  private biomeParticleCurrentSpeed = 1.3;
  private biomeFlickerFreq = 0;
  private lastBiomeParticleIndex = -1;

  // Per-gear crumble SFX edge-detection (armed / falling state transitions)
  private readonly crumbleSfxArmed = new Map<number, boolean>();
  private readonly crumbleSfxFalling = new Map<number, boolean>();

  // Per-gear wind-gust and magnet-pulse SFX rate-limiters
  private readonly windGustNextTimes = new Map<number, number>();
  private readonly magnetPulseNextTimes = new Map<number, number>();
  private backgroundGenerationHeight = 0;
  private cameraKick = 0;
  private readonly cameraDistancePulses: CameraDistancePulse[] = [];
  private readonly cameraShakeOffset = new THREE.Vector3();
  private cameraShakeTimer = 0;
  private readonly cameraShakeDuration = 0.15;
  private comboFovPulseTimer = 0;
  private lastComboMultiplier = 1;
  private closeCallFlashTimer = 0;
  private nearMissSlowTimer = 0;
  private steamSpawnTimer = 0;
  private deathAnimTimer = 0;
  private toastTimer = 0;
  private zoneAnnouncementTimer = 0;
  private lastAnnouncedZone = -1;
  private seenWindGear = false;
  private seenMagnetGear = false;
  private seenGearFreeze = false;
  private windParticleTimer = 0;
  private magnetParticleTimer = 0;
  private gearFreezeParticleTimer = 0;
  private trailWispTimer = 0;
  private gearFreezeActive = false;
  private personalBestHeight = 0;
  private personalBestReachedThisRun = false;
  private personalBestRing: THREE.Mesh | null = null;
  private readonly scorePops: ScorePop[] = [];
  private readonly zoneAnnouncementDuration = 2;
  private tutorialShown = false;
  private tutorialFadeTimer: number | null = null;
  private tutorialHideTimer: number | null = null;
  private tutorialDismissHandler: (() => void) | null = null;

  // Tracks the last sim-side score so score-pops reflect sim-earned points
  // only. Contract bonuses generate their own pops at the moment they
  // complete; they would double-count if routed through this diff.
  private lastSimScore = 0;

  // Run Contracts state.
  private activeContracts: ContractInstance[] = [];
  // Pre-rolled contracts shown on the title/game-over screen that will be
  // committed when the player starts a new (non-daily) run.
  private previewContracts: ContractInstance[] = [];
  private contractBonus = 0;
  private contractNearMisses = 0;
  private contractPowerupsCollected = 0;
  // elapsedTime at which the last shield_save event fired (for the
  // "survive N seconds without a shield break" contract).
  private contractLastShieldSaveAt = 0;
  private contractRunStartAt = 0;
  private contractsHudPanel!: HTMLDivElement;
  private contractsHudList!: HTMLDivElement;
  private contractsPreviewPanel!: HTMLDivElement;
  private contractsPreviewList!: HTMLDivElement;

  private readonly zoneNames = [
    "BRONZE DEPTHS",
    "IRON WORKS",
    "SILVER SPIRES",
    "GOLDEN HEIGHTS",
    "CHROME ABYSS",
  ] as const;

  private readonly sceneBackgroundColor = new THREE.Color(0x140d0a);
  private readonly currentFogColor = new THREE.Color(0x140d0a);
  private readonly currentAmbientColor = new THREE.Color(0xc7aa7a);
  private ambientLight!: THREE.AmbientLight;
  private readonly zoneBgColor = new THREE.Color();
  private readonly zoneNextBgColor = new THREE.Color();
  private readonly zoneAmbientColor = new THREE.Color();
  private readonly zoneNextAmbientColor = new THREE.Color();

  async start() {
    await this.init();
    this.resumeAnimationLoop();
    signalGameReady();
  }

  private async init() {
    await platformInit();
    await requestStats();
    this.saveData = await this.readSaveData();
    this.highScore = this.saveData.bestScore;
    this.personalBestHeight = parseInt(localStorage.getItem("clockwork-personal-best-height") ?? "0") || 0;
    if (!isAudioEnabled()) {
      setAudioEnabled(false);
    } else {
      setAudioEnabled(this.saveData.audioEnabled);
    }

    const container = document.getElementById("game-container");
    if (!container) {
      throw new Error("Missing #game-container");
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.renderer.shadowMap.enabled = false;
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); // Skydome covers visible field; black fills any gaps
    this.scene.fog = new THREE.FogExp2(0x140d0a, 0.014);
    this.scene.add(this.titleBackdropGroup);

    // Gear object pool — persists across restartGame() for maximum reuse savings.
    // disposeAll() is called on page unload only.
    this.gearPool = new GearPool(this.scene);
    window.addEventListener("pagehide", () => { this.gearPool.disposeAll(); }, { once: true });

    // Animated noise skydome — large BackSide sphere follows camera position (not rotation).
    // Noise sampled in object-space direction (= world direction from camera), giving a
    // world-anchored feel: rotating the camera reveals different parts of the sky,
    // and climbing makes the noise field drift past via time-based scrolling.
    {
      const skyGeo = new THREE.SphereGeometry(400, 32, 24);
      const skyMat = new THREE.ShaderMaterial({
        uniforms: {
          uBiomeColor:  { value: new THREE.Color(0xff8020) },
          uTime:        { value: 0 },
          uScrollSpeed: { value: 1.0 },
          uPulseFreq:   { value: 0.0 },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3  uBiomeColor;
          uniform float uTime;
          uniform float uScrollSpeed;
          uniform float uPulseFreq;
          varying vec3 vDir;

          float hash3(vec3 p) {
            p = fract(p * vec3(127.1, 311.7, 74.7));
            p += dot(p, p.zyx + 31.32);
            return fract((p.x + p.y) * p.z);
          }

          float vnoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(mix(hash3(i),               hash3(i + vec3(1,0,0)), f.x),
                  mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
              mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                  mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
              f.z
            );
          }

          float fbm(vec3 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 3; i++) {
              v += a * vnoise(p);
              p = p * 2.1 + vec3(1.7, 9.2, 3.5);
              a *= 0.5;
            }
            return v;
          }

          void main() {
            vec3 dir = normalize(vDir);
            float t = uTime * uScrollSpeed;
            // Two-axis drift so it reads as motion, not a flat pan
            vec3 s = dir * 2.8 + vec3(t * 0.02, t * 0.008, 0.0);
            float n = fbm(s);

            // Highlight where noise exceeds threshold — dark base, aurora-like peaks
            float bloom = smoothstep(0.50, 0.70, n);

            // Optional luminance pulse — very slow ambient breathe only.
            // Capped at low amplitude so the skydome reads as atmospheric,
            // not like a flickering light. Frequencies in BIOME_SKYDOME_CONFIGS
            // should stay well under 1 Hz.
            float pulse = 1.0;
            if (uPulseFreq > 0.0) {
              pulse = 0.85 + 0.15 * (0.5 + 0.5 * sin(uTime * uPulseFreq * 6.2832));
            }

            vec3 color = uBiomeColor * bloom * 0.26 * pulse;
            gl_FragColor = vec4(color, 1.0);
          }
        `,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const skyMesh = new THREE.Mesh(skyGeo, skyMat);
      skyMesh.frustumCulled = false;
      this.scene.add(skyMesh);
      this.skydomeMesh = skyMesh;
      this.skydomeShaderMat = skyMat;
    }

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 6.8, 11.2);
    this.camera.lookAt(0, 4, 0);

    const ambient = new THREE.AmbientLight(0xc7aa7a, 0.9);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const hemisphere = new THREE.HemisphereLight(0xf2dcc2, 0x2b1a10, 0.72);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight(0xffd6a3, 2.8);
    keyLight.position.set(8, 18, 10);
    keyLight.castShadow = false;
    keyLight.target.position.set(0, 10, 0);
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);

    const fillLight = new THREE.DirectionalLight(0xb8703a, 1.08);
    fillLight.position.set(-7, 9, -6);
    this.scene.add(fillLight);

    this.playerLight = new THREE.PointLight(0xffc06a, 12, 16, 2);
    this.playerLight.position.set(0, 4.5, 4);
    this.scene.add(this.playerLight);
    this.topDownShadow = new TopDownShadowSystem(this.renderer, this.scene);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.18,
      0.25,
      0.92
    );
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.bloomPass);

    this.input.init(this.renderer.domElement, (connected) => {
      this.showToast(connected ? "CONTROLLER CONNECTED" : "CONTROLLER DISCONNECTED");
    });

    const comboGlowOverlay = document.createElement("div");
    comboGlowOverlay.style.position = "absolute";
    comboGlowOverlay.style.inset = "0";
    comboGlowOverlay.style.pointerEvents = "none";
    comboGlowOverlay.style.zIndex = "8";
    comboGlowOverlay.style.opacity = "0";
    comboGlowOverlay.style.mixBlendMode = "screen";
    comboGlowOverlay.style.transition = "opacity 120ms ease-out, background 120ms ease-out";
    comboGlowOverlay.style.background = "radial-gradient(circle at center, rgba(255,255,255,0) 58%, rgba(255, 200, 80, 0.12) 100%)";
    container.appendChild(comboGlowOverlay);
    this.comboGlowOverlay = comboGlowOverlay;

    const scorePopLayer = document.createElement("div");
    scorePopLayer.style.position = "absolute";
    scorePopLayer.style.inset = "0";
    scorePopLayer.style.pointerEvents = "none";
    scorePopLayer.style.zIndex = "11";
    scorePopLayer.style.overflow = "hidden";
    container.appendChild(scorePopLayer);
    this.scorePopLayer = scorePopLayer;

    const towerGeo = new THREE.CylinderGeometry(0.8, 0.8, 20000, 12);
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x6f4a22,
      metalness: 0.8,
      roughness: 0.38,
    });
    this.towerBase = new THREE.Mesh(towerGeo, towerMat);
    this.towerBase.position.y = 9990;
    applyTopDownShadowToObject(this.towerBase, this.topDownShadow.uniforms);
    this.scene.add(this.towerBase);

    const pbRingGeo = new THREE.TorusGeometry(1.8, 0.06, 12, 64);
    const pbRingMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.personalBestRing = new THREE.Mesh(pbRingGeo, pbRingMat);
    this.personalBestRing.rotation.x = Math.PI / 2;
    this.personalBestRing.userData.skipTopDownShadowCaster = true;
    this.personalBestRing.visible = false;
    this.scene.add(this.personalBestRing);

    this.scene.add(this.backgroundGroup);
    this.scene.add(this.particles.group);
    this.scene.add(this.ghostGroup);
    this.player.enableTopDownShadow(this.topDownShadow.uniforms);
    this.scene.add(this.player.mesh);
    this.initBiomeParticles();
    this.landingCueGroup.add(this.landingCueGlow, this.landingCueRing, this.landingCueCore);
    this.landingCueGroup.rotation.x = -Math.PI / 2;
    this.landingCueGroup.visible = false;
    this.landingCueGlow.renderOrder = 11;
    this.landingCueRing.renderOrder = 12;
    this.landingCueCore.renderOrder = 13;
    this.scene.add(this.landingCueGroup);

    // Footstep trail removed - replaced with jump/landing particle bursts
    this.player.reset(0, 2);
    this.player.mesh.position.set(0, 0.32, 0);

    const hud = document.getElementById("hud");
    const titleOverlay = document.getElementById("title-overlay");
    const hudScore = document.getElementById("hud-score");
    const hudBest = document.getElementById("hud-best");
    const hudBolts = document.getElementById("hud-bolts");
    const hudStatus = document.getElementById("hud-status");
    const hudToast = document.getElementById("hud-toast");
    const hudControls = document.getElementById("hud-controls");
    const hudCombo = document.getElementById("hud-combo");
    const hudDoubleJumpCharges = document.getElementById("hud-double-jump-charges");
    const hudShieldCount = document.getElementById("hud-shield-count");
    const soundToggleBtn = document.getElementById("sound-toggle");
    const closeCallOverlay = document.getElementById("close-call-overlay");
    const shieldSaveOverlay = document.getElementById("shield-save-overlay");
    const tutorialOverlay = document.getElementById("tutorial-overlay");
    const tutorialControls = document.getElementById("tutorial-controls");
    const tutorialObjective = document.getElementById("tutorial-objective");
    const zoneAnnouncement = document.getElementById("zone-announcement");
    if (!hud || !titleOverlay || !hudScore || !hudBest || !hudBolts || !hudStatus || !hudToast || !hudControls || !hudCombo || !hudDoubleJumpCharges || !hudShieldCount || !soundToggleBtn || !closeCallOverlay || !shieldSaveOverlay || !tutorialOverlay || !tutorialControls || !tutorialObjective || !zoneAnnouncement) {
      throw new Error("Missing HUD elements");
    }
    this.hudAiBadge = document.getElementById("hud-ai-badge");

    // Pickup flash overlay — SVG line player→pill, added lazily so the rest of the HUD
    // doesn't need to know about it. Full-viewport fixed overlay, pointer-events none.
    const overlaySvgNs = "http://www.w3.org/2000/svg";
    const overlaySvg = document.createElementNS(overlaySvgNs, "svg") as SVGSVGElement;
    overlaySvg.id = "hud-pickup-overlay";
    overlaySvg.style.position = "fixed";
    overlaySvg.style.top = "0";
    overlaySvg.style.left = "0";
    overlaySvg.style.width = "100%";
    overlaySvg.style.height = "100%";
    overlaySvg.style.pointerEvents = "none";
    overlaySvg.style.zIndex = "12";
    const pickupLine = document.createElementNS(overlaySvgNs, "line") as SVGLineElement;
    pickupLine.setAttribute("x1", "0");
    pickupLine.setAttribute("y1", "0");
    pickupLine.setAttribute("x2", "0");
    pickupLine.setAttribute("y2", "0");
    pickupLine.setAttribute("stroke", "rgba(255, 170, 68, 0.85)");
    pickupLine.setAttribute("stroke-width", "2");
    pickupLine.setAttribute("stroke-linecap", "round");
    pickupLine.style.opacity = "0";
    pickupLine.style.transition = "opacity 260ms ease-out";
    overlaySvg.appendChild(pickupLine);
    document.body.appendChild(overlaySvg);
    this.hudOverlaySvg = overlaySvg;
    this.hudPickupLine = pickupLine;

    this.hud = hud;
    this.titleOverlay = titleOverlay;
    this.hudScore = hudScore;
    this.hudBest = hudBest;
    this.hudBolts = hudBolts;
    this.hudStatus = hudStatus;
    this.hudToast = hudToast;
    this.hudControls = hudControls;
    this.hudCombo = hudCombo;
    this.hudDoubleJumpCharges = hudDoubleJumpCharges;
    this.hudShieldCount = hudShieldCount;
    this.soundToggleBtn = soundToggleBtn;
    this.closeCallOverlay = closeCallOverlay;
    this.shieldSaveOverlay = shieldSaveOverlay;
    this.tutorialOverlay = tutorialOverlay;
    this.tutorialControls = tutorialControls;
    this.tutorialObjective = tutorialObjective;
    this.zoneAnnouncement = zoneAnnouncement;

    const heading = this.titleOverlay.querySelector("h1");
    const tagline = this.titleOverlay.querySelector(".tagline");
    const titleBest = document.getElementById("title-best");
    const titleActions = document.getElementById("title-actions");
    const prompt = this.titleOverlay.querySelector(".prompt");
    const gameOverView = document.getElementById("game-over-view");
    const gameOverCard = this.titleOverlay.querySelector(".game-over-card");
    const shareScoreBtn = document.getElementById("share-score-btn");
    const gameOverHeight = document.getElementById("go-height");
    const gameOverBolts = document.getElementById("go-bolts");
    const gameOverBoltCount = document.getElementById("go-bolt-count");
    const gameOverCombo = document.getElementById("go-combo");
    const gameOverTime = document.getElementById("go-time");
    const gameOverTotal = document.getElementById("go-total");
    if (
      !heading ||
      !tagline ||
      !titleBest ||
      !titleActions ||
      !prompt ||
      !gameOverView ||
      !gameOverCard ||
      !shareScoreBtn ||
      !gameOverHeight ||
      !gameOverBolts ||
      !gameOverBoltCount ||
      !gameOverCombo ||
      !gameOverTime ||
      !gameOverTotal
    ) {
      throw new Error("Missing title overlay elements");
    }

    this.titleHeading = heading as HTMLElement;
    this.titleTagline = tagline as HTMLElement;
    this.titleBest = titleBest;
    this.titleActions = titleActions;
    this.titlePrompt = prompt as HTMLElement;
    this.gameOverView = gameOverView;
    this.gameOverCard = gameOverCard as HTMLElement;
    this.shareScoreBtn = shareScoreBtn as HTMLButtonElement;
    this.gameOverHeightEl = gameOverHeight;
    this.gameOverBoltsEl = gameOverBolts;
    this.gameOverBoltCountEl = gameOverBoltCount;
    this.gameOverComboEl = gameOverCombo;
    this.gameOverTimeEl = gameOverTime;
    this.gameOverTotalEl = gameOverTotal;
    this.createLeaderboardPanels();

    const pauseOverlay = document.getElementById("pause-overlay");
    const pauseBtn = document.getElementById("pause-btn");
    if (!pauseOverlay || !pauseBtn) {
      throw new Error("Missing pause elements");
    }
    this.pauseOverlay = pauseOverlay;
    this.pauseBtn = pauseBtn;

    const updateSoundBtn = () => {
      this.soundToggleBtn.textContent = getAudioEnabled() ? "🔊" : "🔇";
    };
    updateSoundBtn();
    this.soundToggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAudio();
      updateSoundBtn();
    });

    this.shareScoreBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = this.isDailyChallenge
        ? `I scored ${this.score} climbing ${this.heightMaxReached}m in the Clockwork Climb Daily Challenge (${formatHumanDate(this.dailyChallengeDate)})! ⚙️\nCan you beat today's tower?\n#gamedevjs #gamedev @tommyatoai`
        : `I scored ${this.score} climbing ${this.heightMaxReached}m in Clockwork Climb! ⚙️\nCan you beat my score?\n#gamedevjs #gamedev @tommyatoai`;
      const shareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://tommyato.com/games/clockwork-climb/")}`;
      window.open(shareUrl, "_blank", "noopener,noreferrer");
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.state === GameState.Playing) {
          this.pauseGame();
        } else if (this.state === GameState.Paused) {
          this.resumeGame();
        }
      }
    });

    const isPauseActionTarget = (target: HTMLElement | null) =>
      Boolean(target && (target.closest("#pause-restart") || target.closest("#pause-title") || target.closest("button")));

    this.pauseOverlay.addEventListener("click", (event) => {
      if (!isPauseActionTarget(event.target as HTMLElement)) {
        this.resumeGame();
      }
    });
    this.pauseOverlay.addEventListener("touchend", (event) => {
      if (!isPauseActionTarget(event.target as HTMLElement)) {
        event.preventDefault();
        this.resumeGame();
      }
    }, { passive: false });

    const pauseRestartBtn = document.getElementById("pause-restart");
    pauseRestartBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.startGame();
    });

    const pauseTitleBtn = document.getElementById("pause-title") as HTMLButtonElement | null;
    if (pauseTitleBtn) {
      pauseTitleBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.returnToTitle();
      });
      this.pauseTitleBtn = pauseTitleBtn;
    }

    const gameOverTitleBtn = document.getElementById("gameover-title") as HTMLButtonElement | null;
    if (gameOverTitleBtn) {
      gameOverTitleBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.returnToTitle();
      });
    }

    this.pauseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.state === GameState.Playing) {
        this.pauseGame();
      }
    });

    const handleOverlayActivate = (event: Event) => {
      if (this.state !== GameState.Title && this.state !== GameState.GameOver) {
        return;
      }
      if ((event.target as HTMLElement).closest("button")) {
        return;
      }
      event.preventDefault();
      this.startGame();
    };

    this.titleOverlay.addEventListener("click", handleOverlayActivate);
    this.titleOverlay.addEventListener("touchend", handleOverlayActivate, { passive: false });

    // PLAY button — the former pulsing prompt text, now a proper button
    const handlePlayActivate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.state !== GameState.Title && this.state !== GameState.GameOver) return;
      this.startGame();
    };
    this.titlePrompt.addEventListener("click", handlePlayActivate);
    this.titlePrompt.addEventListener("touchend", handlePlayActivate, { passive: false });

    this.resetVisualWorld();
    const { state } = this.sim.reset();
    this.consumeState(state);
    this.syncVisuals(state);
    this.player.mesh.position.set(0, 0.32, 0);
    this.buildBackgroundAtmosphere(this.getMaxGearHeight(state) + 24);
    this.buildTitleBackdrop();
    await this.refreshLeaderboardPanels();
    this.setupAchievementsUi();
    this.setupLeaderboardModal();
    this.setupGameOverButtons();
    void this.loadAchievementCatalog();
    this.setupMultiplayerUi(container);
    this.setupMultiplayerCallbacks();
    this.initAIGhost();
    this.setupAIGhostButton();
    void this.setupGhostChallenge();
    this.setupUsernameUi();
    this.setupDailyChallengeButton();
    this.setupContractsUi(container);
    this.rerollPreviewContracts();
    this.renderContractsPreview();
    this.applyHudRailState();
    this.updateHud(dtZero());
    this.updateOverlayText();
    this.input.setTouchControlsVisible(false);

    window.addEventListener("resize", () => this.onResize());

    registerPauseHandlers(
      () => this.pauseAnimationLoop(),
      () => this.resumeAnimationLoop()
    );
    setAudioEnabled(isAudioEnabled() && this.saveData.audioEnabled);
    onAudioChange((enabled) => setAudioEnabled(enabled));

    // Debug hooks — only installed when ?debug is present in the URL.
    // window.__clockworkClimb is intentionally undefined when ?debug is absent.
    if (new URLSearchParams(location.search).has('debug')) {
      (window as any).__clockworkClimb = {
        forceGameOver: () => {
          if (this.state === GameState.Playing && this.simState) {
            this.finishGame(this.simState);
          }
        },
        unlockTestAchievement: () => {
          this.showAchievementToast(formatAchievementId('FIRST_CLIMB'));
        },
        getGameState: () => GameState[this.state],
        // GearPool profiling — read window.__gearAllocs directly or via this accessor.
        gearAllocs: () => this.gearPool.allocCount,
      };
    }

    await signalLoadComplete();
  }

  private createLeaderboardPanels() {
    this.titleLeaderboardPanel = this.buildLeaderboardPanel("TOP 10 SCORES");
    this.titleLeaderboardPanel.classList.add("leaderboard-panel", "title-leaderboard-panel");
    this.titleLeaderboardContext = this.titleLeaderboardPanel.querySelector("[data-role='context']") as HTMLElement;
    this.titleLeaderboardThreshold = this.titleLeaderboardPanel.querySelector("[data-role='threshold']") as HTMLElement;
    this.titleLeaderboardList = this.titleLeaderboardPanel.querySelector("[data-role='list']") as HTMLElement;
    this.titleOverlay.appendChild(this.titleLeaderboardPanel);

    this.gameOverLeaderboardPanel = this.buildLeaderboardPanel("RUN CONTEXT");
    this.gameOverLeaderboardPanel.classList.add("leaderboard-panel", "game-over-leaderboard-panel");
    this.gameOverLeaderboardContext = this.gameOverLeaderboardPanel.querySelector("[data-role='context']") as HTMLElement;
    this.gameOverLeaderboardThreshold = this.gameOverLeaderboardPanel.querySelector("[data-role='threshold']") as HTMLElement;
    this.gameOverLeaderboardList = this.gameOverLeaderboardPanel.querySelector("[data-role='list']") as HTMLElement;
    this.gameOverLeaderboardPanel.classList.add("hidden");
    const gameOverRightCol = document.getElementById("game-over-right-col");
    if (gameOverRightCol) {
      // Prepend so leaderboard appears above the contracts/unlocks rows in HTML.
      gameOverRightCol.prepend(this.gameOverLeaderboardPanel);
    }
  }

  private buildLeaderboardPanel(title: string): HTMLElement {
    const panel = document.createElement("div");
    panel.style.padding = "16px 18px";
    panel.style.borderRadius = "18px";
    panel.style.border = "1px solid rgba(255, 196, 120, 0.18)";
    panel.style.background = "linear-gradient(180deg, rgba(27, 18, 14, 0.78), rgba(13, 10, 9, 0.62))";
    panel.style.boxShadow = "0 16px 40px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 226, 176, 0.08)";
    panel.style.backdropFilter = "blur(10px)";
    panel.style.fontFamily = 'ui-monospace, "Cascadia Code", "Fira Code", monospace';
    panel.style.color = "#f3d7b1";
    panel.style.textAlign = "left";
    panel.innerHTML = `
      <div style="font-size:11px; letter-spacing:2px; color:#c7a271; margin-bottom:8px;">${title}</div>
      <div data-role="context" style="font-size:11px; letter-spacing:2px; color:#7fd6ff; margin-bottom:10px;"></div>
      <div data-role="threshold" style="font-size:10px; letter-spacing:1.4px; color:#ffcf84; margin-bottom:10px; line-height:1.35;"></div>
      <div data-role="list" style="display:grid; gap:6px;"></div>
    `;
    return panel;
  }

  private async refreshLeaderboardPanels(slug: "high-score" | "daily-score" = "high-score") {
    const entries = await fetchLeaderboardScores(slug);
    const normalizedEntries = entries.map((entry, index) => ({
      username: entry.username,
      score: entry.score,
      rank: entry.rank ?? index + 1,
    }));
    this.titleLeaderboardEntries = normalizedEntries;
    this.gameOverLeaderboardEntries = normalizedEntries;
    this.renderLeaderboardList(
      this.titleLeaderboardContext,
      this.titleLeaderboardList,
      this.titleLeaderboardEntries,
      this.titleLeaderboardEntries.length > 0 ? "WAVEDASH OR LOCAL TOP RUNS" : "NO RUNS YET"
    );
    this.titleLeaderboardThreshold.textContent = this.getLeaderboardThresholdCallout(this.titleLeaderboardEntries);
    this.renderLeaderboardList(
      this.gameOverLeaderboardContext,
      this.gameOverLeaderboardList,
      this.gameOverLeaderboardEntries,
      slug === "daily-score"
        ? `DAILY CHALLENGE · ${formatHumanDate(this.dailyChallengeDate)} · THIS RUN ${this.score}`
        : `THIS RUN ${this.score} · BEST ${this.saveData.bestScore}`
    );
    this.gameOverLeaderboardThreshold.textContent = this.getGameOverCallout();
    this.renderTitleLeaderboardSummary();
  }

  private renderLeaderboardList(
    contextEl: HTMLElement,
    listEl: HTMLElement,
    entries: LeaderboardDisplayEntry[],
    contextText: string
  ) {
    contextEl.textContent = contextText;
    if (entries.length === 0) {
      listEl.innerHTML = "<div style='font-size:12px; letter-spacing:2px; color:#8f8a85;'>NO SCORES RECORDED</div>";
      return;
    }

    listEl.innerHTML = entries.slice(0, 10).map((entry) => (
      `<div style="display:grid; grid-template-columns: 32px 1fr auto; gap:10px; align-items:baseline; font-size:13px; letter-spacing:1px;">
        <span style="color:#c7a271;">#${entry.rank}</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(entry.username)}</span>
        <span style="color:#ffaa44; font-weight:700;">${entry.score}</span>
      </div>`
    )).join("");
  }

  private getLeaderboardThresholdCallout(entries: LeaderboardDisplayEntry[]) {
    if (entries.length === 0) {
      return "TARGETS · SCORE 500+ · HEIGHT 25m+ · COMBO x3+";
    }

    const bestEntry = entries[0];
    const scoreTarget = Math.max(500, Math.ceil(bestEntry.score / 500) * 500);
    const heightTarget = Math.max(25, Math.ceil(this.saveData.bestHeight / 25) * 25 || 25);
    const comboTarget = Math.max(3, Math.min(10, Math.ceil(Math.max(this.saveData.bestCombo, this.bestCombo) / 2) + 1));
    return `TARGETS · SCORE ${scoreTarget}+ · HEIGHT ${heightTarget}m+ · COMBO x${comboTarget}+`;
  }

  private getGameOverCallout() {
    if (this.isDailyChallenge) {
      const countdown = formatCountdown(getUtcMsUntilTomorrow());
      return this.dailyPreviousBest !== null
        ? `DAILY BEST: ${this.dailyPreviousBest} · COME BACK TOMORROW · NEW RUN IN ${countdown} UTC`
        : `COME BACK TOMORROW · NEW RUN IN ${countdown} UTC`;
    }
    return `CHECKPOINTS · NEXT ${this.nextMilestone}m · ZONES 25/50/75/100`;
  }

  // -----------------------------------------------------------------------
  // Achievements UI
  // -----------------------------------------------------------------------

  private setupAchievementsUi() {
    const button = document.getElementById("title-btn-achievements") as HTMLButtonElement | null;
    const gameOverButton = document.getElementById("gameover-achievements") as HTMLButtonElement | null;
    const overlay = document.getElementById("achievements-overlay") as HTMLDivElement | null;
    const closeBtn = document.getElementById("achievements-close") as HTMLButtonElement | null;

    if (!button || !overlay || !closeBtn) {
      return;
    }

    this.achievementsButton = button;
    this.achievementsPanel = overlay;

    const openFromBtn = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openAchievementsPanel();
    };
    button.addEventListener("click", openFromBtn);
    button.addEventListener("touchend", openFromBtn, { passive: false });
    if (gameOverButton) {
      gameOverButton.addEventListener("click", openFromBtn);
      gameOverButton.addEventListener("touchend", openFromBtn, { passive: false });
    }

    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeAchievementsPanel();
    });
    closeBtn.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeAchievementsPanel();
    }, { passive: false });

    // Click outside the card closes it; clicks inside do not bubble to startGame.
    overlay.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target === overlay) {
        event.preventDefault();
        event.stopPropagation();
        this.closeAchievementsPanel();
      } else {
        event.stopPropagation();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Leaderboard modal (LEADERBOARD pill opens an overlay instead of using
  // the always-visible panel so the single-column title screen stays clean).
  // -----------------------------------------------------------------------
  private leaderboardModal: HTMLDivElement | null = null;
  private leaderboardModalBody: HTMLDivElement | null = null;

  private setupLeaderboardModal(): void {
    const modal = document.getElementById("leaderboard-modal") as HTMLDivElement | null;
    const body = document.getElementById("leaderboard-modal-body") as HTMLDivElement | null;
    const closeBtn = document.getElementById("leaderboard-modal-close") as HTMLButtonElement | null;
    const titleBtn = document.getElementById("title-btn-leaderboard") as HTMLButtonElement | null;
    const gameOverBtn = document.getElementById("gameover-leaderboard") as HTMLButtonElement | null;
    if (!modal || !body || !closeBtn) return;

    this.leaderboardModal = modal;
    this.leaderboardModalBody = body;

    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openLeaderboardModal();
    };
    titleBtn?.addEventListener("click", open);
    titleBtn?.addEventListener("touchend", open, { passive: false });
    gameOverBtn?.addEventListener("click", open);
    gameOverBtn?.addEventListener("touchend", open, { passive: false });

    const close = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeLeaderboardModal();
    };
    closeBtn.addEventListener("click", close);
    closeBtn.addEventListener("touchend", close, { passive: false });

    modal.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target === modal) {
        event.preventDefault();
        event.stopPropagation();
        this.closeLeaderboardModal();
      } else {
        event.stopPropagation();
      }
    });
  }

  private openLeaderboardModal(): void {
    if (!this.leaderboardModal || !this.leaderboardModalBody) return;
    this.renderLeaderboardModalBody();
    this.leaderboardModal.classList.remove("hidden");
    this.leaderboardModal.setAttribute("aria-hidden", "false");
  }

  private closeLeaderboardModal(): void {
    if (!this.leaderboardModal) return;
    this.leaderboardModal.classList.add("hidden");
    this.leaderboardModal.setAttribute("aria-hidden", "true");
  }

  private renderLeaderboardModalBody(): void {
    if (!this.leaderboardModalBody) return;
    const entries = this.titleLeaderboardEntries;
    if (entries.length === 0) {
      this.leaderboardModalBody.innerHTML =
        "<div style='font-size:13px; letter-spacing:2px; color:#8f8a85;'>NO SCORES RECORDED</div>";
      return;
    }
    const rows = entries.slice(0, 10).map((entry) => (
      `<div style="display:grid; grid-template-columns: 40px 1fr auto; gap:12px; padding:8px 4px; align-items:baseline; font-size:14px; letter-spacing:1px; border-bottom:1px solid rgba(127,214,255,0.08);">
        <span style="color:#c7a271;">#${entry.rank}</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(entry.username)}</span>
        <span style="color:#ffaa44; font-weight:700;">${entry.score}</span>
      </div>`
    )).join("");
    this.leaderboardModalBody.innerHTML = rows;
  }

  private renderTitleLeaderboardSummary(): void {
    const el = document.getElementById("title-leaderboard-summary");
    if (!el) return;
    const entries = this.titleLeaderboardEntries;
    if (entries.length === 0) {
      el.textContent = "";
      return;
    }
    const top = entries[0];
    const heightPart = this.saveData.bestHeight > 0 ? ` · ${this.saveData.bestHeight}m` : "";
    el.textContent = `#1 ${top.username} · ${top.score}${heightPart}`;
  }

  // -----------------------------------------------------------------------
  // Game-over action buttons (play again, title screen, etc.)
  // -----------------------------------------------------------------------
  private setupGameOverButtons(): void {
    const playAgain = document.getElementById("gameover-play-again") as HTMLButtonElement | null;
    if (playAgain) {
      const handler = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        this.startGame();
      };
      playAgain.addEventListener("click", handler);
      playAgain.addEventListener("touchend", handler, { passive: false });
    }
  }

  // -----------------------------------------------------------------------
  // HUD rail — on wide viewports (>= 1280px), render the HUD as a right
  // rail so the gameplay claims the left ~78% of the canvas. CSS does the
  // actual layout; this method just toggles the body class that gates it.
  // -----------------------------------------------------------------------
  private applyHudRailState(): void {
    const wide = window.innerWidth >= 1280;
    document.body.classList.toggle("hud-rail", wide);
  }

  private async loadAchievementCatalog() {
    try {
      const progress = listAchievementProgress();
      this.achievementCatalog = progress.map((entry) => ({
        id: entry.id,
        title: entry.displayName,
        description: entry.description,
      }));
    } catch (error) {
      console.error("Failed to load achievement catalog", error);
      this.achievementCatalog = [];
    }
  }

  private setupDailyChallengeButton(): void {
    const btn = document.getElementById("title-btn-daily") as HTMLButtonElement | null;
    if (!btn) return;
    Object.assign(btn.style, {
      border: "1px solid rgba(255, 210, 110, 0.5)",
      background: "linear-gradient(180deg, rgba(58, 38, 10, 0.94), rgba(28, 18, 6, 0.84))",
      boxShadow: "0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255, 239, 184, 0.24)",
      color: "#ffe19d",
    } as CSSStyleDeclaration);
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startDailyChallenge();
    });
    btn.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startDailyChallenge();
    }, { passive: false });
  }

  private startDailyChallenge(): void {
    this.isDailyChallenge = true;
    this.dailyChallengeDate = utcDateKey();
    this.dailyPreviousBest = this.readDailyBest(this.dailyChallengeDate);
    this.sim.setSeed(dailySeed(this.dailyChallengeDate));
    this.startGame();
  }

  // -----------------------------------------------------------------------
  // Run Contracts — UI, rolling, live tracking, completion bonuses.
  // -----------------------------------------------------------------------

  private setupContractsUi(_container: HTMLElement): void {
    // Live HUD panel and title-screen preview panel are both declared in
    // index.html so their ids are stable and greppable. We just grab the
    // existing elements and wire the reroll button here.
    const hudPanel = document.getElementById("hud-contracts") as HTMLDivElement | null;
    const previewPanel = document.getElementById("title-contracts-preview") as HTMLDivElement | null;
    const rerollBtn = document.getElementById("title-contracts-reroll") as HTMLButtonElement | null;
    if (!hudPanel || !previewPanel || !rerollBtn) {
      throw new Error("Missing contracts UI elements in index.html");
    }

    const previewList = previewPanel.querySelector(".contracts-preview-list") as HTMLDivElement | null;
    if (!previewList) {
      throw new Error("Missing .contracts-preview-list inside #title-contracts-preview");
    }

    this.contractsHudPanel = hudPanel;
    this.contractsHudList = hudPanel;
    this.contractsPreviewPanel = previewPanel;
    this.contractsPreviewList = previewList;

    rerollBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      playClick();
      this.rerollPreviewContracts();
      this.renderContractsPreview();
    });
    rerollBtn.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      playClick();
      this.rerollPreviewContracts();
      this.renderContractsPreview();
    }, { passive: false });
  }

  private rerollPreviewContracts(): void {
    this.previewContracts = pickRandomContracts(3);
  }

  private renderContractsPreview(): void {
    this.contractsPreviewList.innerHTML = this.previewContracts
      .map((c) => `
        <div style="display:grid; grid-template-columns: 14px 1fr auto; gap:10px; align-items:baseline; font-size:12px; letter-spacing:1px;">
          <span style="color:#c7a271;">◯</span>
          <span style="color:#f3d7b1;">${escapeHtml(c.def.label)}</span>
          <span style="color:#ffaa44; font-weight:700;">+${c.def.reward}</span>
        </div>
      `)
      .join("");
  }

  private renderContractsHud(): void {
    const heading = `<div class="hud-label" style="margin-bottom:4px;">CONTRACTS</div>`;
    const rows = this.activeContracts
      .map((c) => {
        const tick = c.complete ? "✓" : "◯";
        const tickColor = c.complete ? "#9aff9a" : "#c7a271";
        const labelColor = c.complete ? "#cfeed0" : "#f3d7b1";
        const labelDecoration = c.complete ? "line-through" : "none";
        const progress = c.complete ? `+${c.def.reward}` : formatContractProgress(c);
        const progressColor = c.complete ? "#9aff9a" : "#ffaa44";
        const pulseScale = c.celebrateTimer > 0 ? 1 + c.celebrateTimer * 0.2 : 1;
        return `
          <div class="hud-contract-row" style="transform:scale(${pulseScale}); transform-origin:left center; transition: transform 120ms ease-out;">
            <span style="color:${tickColor};">${tick}</span>
            <span style="color:${labelColor}; text-decoration:${labelDecoration}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.def.label)}</span>
            <span style="color:${progressColor}; font-weight:700; font-size:10px;">${progress}</span>
          </div>
        `;
      })
      .join("");
    this.contractsHudList.innerHTML = heading + rows;
  }

  private commitContractsForRun(): void {
    if (this.isDailyChallenge) {
      this.activeContracts = [];
      this.contractsHudPanel.classList.add("empty");
      return;
    }
    if (this.previewContracts.length === 0) {
      this.rerollPreviewContracts();
    }
    // Clone so in-run progress updates don't pollute the preview list.
    this.activeContracts = this.previewContracts.map((c) => ({
      def: c.def,
      progress: 0,
      complete: false,
      celebrateTimer: 0,
    }));
    this.contractsHudPanel.classList.remove("empty");
    this.renderContractsHud();
  }

  private resetContractRunCounters(): void {
    this.contractBonus = 0;
    this.contractNearMisses = 0;
    this.contractPowerupsCollected = 0;
    this.contractLastShieldSaveAt = this.elapsedTime;
    this.contractRunStartAt = this.elapsedTime;
  }

  private updateContracts(dt: number): void {
    if (this.activeContracts.length === 0 || !this.simState) {
      return;
    }

    const runTime = Math.max(0, this.elapsedTime - this.contractRunStartAt);
    const ctx: ContractCtx = {
      state: this.simState,
      nearMisses: this.contractNearMisses,
      powerupsCollected: this.contractPowerupsCollected,
      timeSinceLastShieldBreak: Math.max(0, this.elapsedTime - this.contractLastShieldSaveAt),
      runTime,
    };

    let anyChanged = false;
    for (const instance of this.activeContracts) {
      if (instance.celebrateTimer > 0) {
        instance.celebrateTimer = Math.max(0, instance.celebrateTimer - dt);
        anyChanged = true;
      }
      if (instance.complete) {
        continue;
      }
      const nextProgress = instance.def.progress(ctx);
      if (nextProgress !== instance.progress) {
        instance.progress = nextProgress;
        anyChanged = true;
      }
      if (nextProgress >= instance.def.target) {
        instance.complete = true;
        instance.celebrateTimer = 0.5;
        this.contractBonus += instance.def.reward;
        this.score += instance.def.reward;
        this.spawnScorePop(instance.def.reward);
        this.showToast(`CONTRACT COMPLETE · ${instance.def.label} · +${instance.def.reward}`);
        playAchievementUnlock();
        anyChanged = true;
      }
    }

    if (anyChanged) {
      this.renderContractsHud();
    }
  }

  private openAchievementsPanel() {
    if (!this.achievementsPanel) {
      return;
    }
    playClick();
    this.renderAchievementsList();
    this.achievementsPanel.classList.remove("hidden");
    this.achievementsPanel.setAttribute("aria-hidden", "false");
  }

  private closeAchievementsPanel() {
    if (!this.achievementsPanel) {
      return;
    }
    playClick();
    this.achievementsPanel.classList.add("hidden");
    this.achievementsPanel.setAttribute("aria-hidden", "true");
  }

  private renderAchievementsList() {
    const listEl = document.getElementById("achievements-list");
    const summaryEl = document.getElementById("achievements-summary");
    if (!listEl || !summaryEl) {
      return;
    }

    // Always pull fresh state (SDK may have updated since we loaded)
    const progress: AchievementProgress[] = (() => {
      try {
        return listAchievementProgress();
      } catch {
        // Fall back to the cached catalog marked as locked.
        return this.achievementCatalog.map((entry) => ({
          id: entry.id,
          displayName: entry.title,
          description: entry.description,
          unlocked: false,
        }));
      }
    })();

    const unlocked = progress.filter((entry) => entry.unlocked).length;
    const total = progress.length;
    summaryEl.textContent = total === 0
      ? "NO ACHIEVEMENTS CONFIGURED"
      : `UNLOCKED ${unlocked} / ${total}`;

    if (progress.length === 0) {
      listEl.innerHTML = `<div style="padding:12px; color:#9cb5c5; font-family:ui-monospace,monospace; font-size:11px; letter-spacing:1.5px;">Play a run to earn your first achievement.</div>`;
      return;
    }

    // Unlocked first, then locked, preserving catalog order within each group.
    const ordered = [...progress].sort((a, b) => {
      if (a.unlocked === b.unlocked) return 0;
      return a.unlocked ? -1 : 1;
    });

    listEl.innerHTML = ordered.map((entry) => `
      <div class="achievement-row ${entry.unlocked ? "unlocked" : "locked"}">
        <div>
          <div class="achievement-name">${escapeHtml(entry.displayName)}</div>
          <div class="achievement-description">${escapeHtml(entry.description)}</div>
        </div>
        <div class="achievement-status">${entry.unlocked ? "UNLOCKED" : "LOCKED"}</div>
      </div>
    `).join("");
  }

  // -----------------------------------------------------------------------
  // Title return (from pause / game-over back to title / mode select)
  // -----------------------------------------------------------------------

  private returnToTitle() {
    playClick();

    this.isDailyChallenge = false;
    this.dailyChallengeDate = utcDateKey();
    this.dailyPreviousBest = null;
    this.sim.setSeed(this.regularSeed);
    this.state = GameState.Title;
    // Dismissing the game-over overlay — flush any queued achievement
    // unlocks as toasts so they can't be silently lost.
    this.flushAchievementUnlockQueue();
    this.pauseOverlay.classList.add("hidden");
    this.hud.classList.add("hidden");
    this.gameOverView.classList.add("hidden");
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.titleLeaderboardPanel.classList.remove("hidden");
    this.titleOverlay.classList.remove("hidden");
    this.closeCallOverlay.style.opacity = "0";
    this.shieldSaveOverlay.style.opacity = "0";
    this.hideTutorialOverlay(true);
    this.hideLandingCueHard();
    // Trail sampling removed
    if (this.personalBestRing) {
      this.personalBestRing.visible = false;
    }

    this.player.resetVisuals();
    this.player.reset(0, 2);

    this.resetVisualWorld();
    const { state } = this.sim.reset();
    this.consumeState(state);
    this.syncVisuals(state);
    this.buildBackgroundAtmosphere(this.getMaxGearHeight(state) + 24);
    this.buildTitleBackdrop();
    this.updateOverlayText();
    void this.refreshLeaderboardPanels();

    this.titleTagline.classList.remove("new-best");
    this.deathAnimTimer = 0;
    this.toastTimer = 0;
    this.zoneAnnouncementTimer = 0;
    this.lastAnnouncedZone = -1;
    this.cameraShakeTimer = 0;
    this.cameraShakeOffset.set(0, 0, 0);
    this.cameraDistancePulses.length = 0;
    this.comboFovPulseTimer = 0;
    this.zoneAnnouncement.style.opacity = "0";

    this.input.setTouchControlsVisible(false);
    stopMusic();
    stopAmbientTick();
    this.resumeAnimationLoop();

    if (this.multiplayer.isActive()) {
      this.hideMultiplayerPanel();
    }
    if (this.multiplayerButton) {
      this.multiplayerButton.style.display = "inline-flex";
    }
    if (this.aiGhostButton) {
      this.aiGhostButton.style.display = "inline-flex";
    }
    this.clearGhostMeshes();
    this.resetAIGhost();

    this.isChallengeMode = false;
    this.ghostRecorder.stop();
    if (this.ghostPlayback) {
      this.ghostPlayback.dispose();
      this.ghostPlayback = null;
    }

    // Hide the live HUD panel and show a fresh preview on the title screen.
    this.activeContracts = [];
    this.contractsHudPanel.classList.add("empty");
    this.rerollPreviewContracts();
    this.renderContractsPreview();
    this.contractsPreviewPanel.classList.remove("hidden");
  }

  // -----------------------------------------------------------------------
  // Multiplayer UI + ghost rendering
  // -----------------------------------------------------------------------

  private setupMultiplayerUi(container: HTMLElement) {
    const button = document.getElementById("title-btn-versus") as HTMLButtonElement | null;
    if (!button) {
      return;
    }
    if (!this.multiplayer.isAvailable()) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.title = "Multiplayer unavailable in this build.";
      return;
    }

    Object.assign(button.style, {
      border: "1px solid rgba(127, 214, 255, 0.45)",
      background: "linear-gradient(180deg, rgba(14, 32, 46, 0.92), rgba(8, 16, 24, 0.82))",
      boxShadow: "0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(173, 232, 255, 0.18)",
      color: "#d7f8ff",
    } as CSSStyleDeclaration);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openMultiplayerLobby();
    });
    button.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openMultiplayerLobby();
    }, { passive: false });
    this.multiplayerButton = button;

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      padding: "20px 20px 16px",
      borderRadius: "18px",
      border: "1px solid rgba(127, 214, 255, 0.32)",
      background: "linear-gradient(180deg, rgba(14, 28, 40, 0.96), rgba(6, 14, 22, 0.88))",
      boxShadow: "0 16px 40px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(173, 232, 255, 0.12)",
      backdropFilter: "blur(14px)",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      color: "#d7f8ff",
      width: "min(420px, calc(100vw - 40px))",
      boxSizing: "border-box",
      textAlign: "left",
      pointerEvents: "auto",
      position: "relative",
      maxHeight: "80vh",
      overflowY: "auto",
    } as CSSStyleDeclaration);
    panel.addEventListener("click", (event) => event.stopPropagation());
    panel.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

    // ── 0. Close / Back button ────────────────────────────────────────────────
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "← BACK";
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "14px",
      right: "16px",
      padding: "4px 12px",
      borderRadius: "999px",
      border: "1px solid rgba(127, 214, 255, 0.3)",
      background: "transparent",
      color: "#7fd6ff",
      cursor: "pointer",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "10px",
      fontWeight: "700",
      letterSpacing: "1.5px",
    } as CSSStyleDeclaration);
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.leaveMultiplayer();
    });
    closeBtn.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.leaveMultiplayer();
    }, { passive: false });
    panel.appendChild(closeBtn);

    // ── 1. Title ──────────────────────────────────────────────────────────────
    const titleEl = document.createElement("div");
    Object.assign(titleEl.style, {
      fontSize: "14px",
      fontWeight: "700",
      letterSpacing: "2px",
      color: "#ffc878",
      marginBottom: "14px",
      textAlign: "center",
    } as CSSStyleDeclaration);
    titleEl.textContent = "VERSUS — Race to 100 m";
    panel.appendChild(titleEl);

    // ── 2. Rules card ─────────────────────────────────────────────────────────
    const rulesCard = document.createElement("div");
    Object.assign(rulesCard.style, {
      padding: "10px 12px",
      borderRadius: "10px",
      border: "1px solid rgba(127, 214, 255, 0.15)",
      background: "rgba(12, 24, 36, 0.55)",
      fontSize: "11px",
      lineHeight: "1.5",
      color: "#a8d8f0",
      marginBottom: "14px",
      letterSpacing: "0.5px",
    } as CSSStyleDeclaration);
    rulesCard.textContent =
      "First climber to 100 m wins. Ties go to highest score. If nobody reaches 100 m in 120 s, highest score wins. Crumbling gears mean no camping — keep moving.";
    panel.appendChild(rulesCard);

    // ── 3. Players list ───────────────────────────────────────────────────────
    const playersLabel = document.createElement("div");
    Object.assign(playersLabel.style, {
      fontSize: "10px",
      letterSpacing: "2px",
      color: "#7fd6ff",
      marginBottom: "6px",
    } as CSSStyleDeclaration);
    playersLabel.textContent = "PLAYERS";
    panel.appendChild(playersLabel);

    const playerList = document.createElement("div");
    Object.assign(playerList.style, {
      minHeight: "120px",
      marginBottom: "14px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    } as CSSStyleDeclaration);
    panel.appendChild(playerList);
    this.multiplayerPlayerList = playerList;

    // ── 4. Name input ─────────────────────────────────────────────────────────
    const nameLabel = document.createElement("div");
    Object.assign(nameLabel.style, {
      fontSize: "10px",
      letterSpacing: "2px",
      color: "#7fd6ff",
      marginBottom: "5px",
    } as CSSStyleDeclaration);
    nameLabel.textContent = "YOUR NAME";
    panel.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 20;
    nameInput.value = this.getLobbyDisplayName();
    Object.assign(nameInput.style, {
      width: "100%",
      boxSizing: "border-box",
      padding: "7px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(127, 214, 255, 0.3)",
      background: "rgba(10, 22, 34, 0.65)",
      color: "#d7f8ff",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "12px",
      outline: "none",
      marginBottom: "14px",
    } as CSSStyleDeclaration);
    nameInput.addEventListener("keydown", (e) => e.stopPropagation());
    nameInput.addEventListener("keyup", (e) => e.stopPropagation());
    nameInput.addEventListener("keypress", (e) => e.stopPropagation());
    nameInput.addEventListener("input", () => {
      // Strip control chars, enforce max length
      const raw = nameInput.value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 20);
      if (nameInput.value !== raw) nameInput.value = raw;
      if (this.multiplayerNameDebounceHandle !== null) {
        clearTimeout(this.multiplayerNameDebounceHandle);
      }
      this.multiplayerNameDebounceHandle = window.setTimeout(() => {
        this.multiplayerNameDebounceHandle = null;
        const trimmed = nameInput.value.trim();
        // edge: player tries to change name to "" — reject, revert to persisted
        // coolname default. Min 1 char, max 20, control chars already stripped.
        if (trimmed.length === 0) {
          nameInput.value = this.getLobbyDisplayName();
        } else {
          this.setLobbyDisplayName(trimmed);
          this.multiplayer.sendNameUpdate(trimmed);
          this.renderPlayerList();
        }
      }, 300);
    });
    panel.appendChild(nameInput);
    this.multiplayerNameInput = nameInput;

    // ── 5. Invite link ────────────────────────────────────────────────────────
    const inviteLabel = document.createElement("div");
    Object.assign(inviteLabel.style, {
      fontSize: "10px",
      letterSpacing: "2px",
      color: "#7fd6ff",
      marginBottom: "5px",
    } as CSSStyleDeclaration);
    inviteLabel.textContent = "INVITE LINK";
    panel.appendChild(inviteLabel);

    const inviteRow = document.createElement("div");
    Object.assign(inviteRow.style, {
      display: "flex",
      gap: "6px",
      marginBottom: "14px",
      alignItems: "center",
    } as CSSStyleDeclaration);

    const inviteLinkField = document.createElement("input");
    inviteLinkField.type = "text";
    inviteLinkField.readOnly = true;
    inviteLinkField.value = this.multiplayerInviteUrl ?? "generating…";
    Object.assign(inviteLinkField.style, {
      flex: "1",
      minWidth: "0",
      padding: "7px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(127, 214, 255, 0.2)",
      background: "rgba(10, 22, 34, 0.45)",
      color: "#7fd6ff",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "10px",
      outline: "none",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } as CSSStyleDeclaration);
    inviteRow.appendChild(inviteLinkField);
    this.multiplayerInviteLinkField = inviteLinkField;

    const makePanelButton = (label: string, accent: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      Object.assign(b.style, {
        padding: "8px 16px",
        borderRadius: "999px",
        border: `1px solid ${accent}`,
        background: "linear-gradient(180deg, rgba(18, 32, 46, 0.92), rgba(8, 16, 24, 0.82))",
        color: "#d7f8ff",
        cursor: "pointer",
        fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
        fontSize: "12px",
        fontWeight: "700",
        letterSpacing: "2px",
      } as CSSStyleDeclaration);
      return b;
    };

    const inviteBtn = makePanelButton("COPY", "rgba(127, 214, 255, 0.42)");
    inviteBtn.style.padding = "7px 12px";
    inviteBtn.style.flexShrink = "0";
    inviteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copyInviteLink();
    });
    this.multiplayerInviteBtn = inviteBtn;
    inviteRow.appendChild(inviteBtn);
    panel.appendChild(inviteRow);

    // ── 6. Action buttons ─────────────────────────────────────────────────────
    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, {
      display: "flex",
      gap: "8px",
      justifyContent: "center",
      flexWrap: "wrap",
      marginBottom: "10px",
    } as CSSStyleDeclaration);

    const startBtn = makePanelButton("START MATCH", "rgba(255, 196, 120, 0.5)");
    startBtn.style.display = "none"; // shown only for host
    startBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.multiplayer.startMatch();
      this.setMultiplayerStatus("Match starting…");
    });
    this.multiplayerStartBtn = startBtn;
    buttonRow.appendChild(startBtn);

    const leaveBtn = makePanelButton("LEAVE", "rgba(255, 120, 120, 0.4)");
    leaveBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.leaveMultiplayer();
    });
    this.multiplayerLeaveBtn = leaveBtn;
    buttonRow.appendChild(leaveBtn);

    panel.appendChild(buttonRow);

    // ── 7. Status text ────────────────────────────────────────────────────────
    const status = document.createElement("div");
    Object.assign(status.style, {
      fontSize: "11px",
      letterSpacing: "1px",
      color: "#7fd6ff",
      textAlign: "center",
      minHeight: "16px",
    } as CSSStyleDeclaration);
    status.textContent = "";
    panel.appendChild(status);
    this.multiplayerStatus = status;
    // Wrap the inner panel in a full-coverage backdrop overlay so it renders
    // as a proper modal over the title screen, not as a flex child of the
    // mode-row. Mount the wrapper on #title-overlay (which is position:absolute
    // and covers the full game area) so z-index stacking works correctly.
    const panelWrapper = document.createElement("div");
    Object.assign(panelWrapper.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "25",
      background: "rgba(0, 0, 0, 0.65)",
      backdropFilter: "blur(8px)",
      overflowY: "auto",
      padding: "20px",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);
    panelWrapper.addEventListener("click", (event) => event.stopPropagation());
    panelWrapper.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
    panelWrapper.appendChild(panel);
    const titleOverlay = document.getElementById("title-overlay");
    (titleOverlay ?? container).appendChild(panelWrapper);
    this.multiplayerPanel = panelWrapper;

    const labelLayer = document.createElement("div");
    Object.assign(labelLayer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      zIndex: "12",
      overflow: "hidden",
    } as CSSStyleDeclaration);
    container.appendChild(labelLayer);
    this.multiplayerLabelLayer = labelLayer;

    const launchLobby = this.multiplayer.checkLaunchLobby();
    if (launchLobby) {
      void this.joinMultiplayerFromLaunch(launchLobby);
    }
  }

  // ── Multiplayer callback stubs ─────────────────────────────────────────────
  // Full implementations land in Sessions 3-5; these ensure the callbacks are
  // wired and reachable now so later sessions can fill in the bodies.

  private setupMultiplayerCallbacks(): void {
    this.multiplayer.setCallbacks({
      onMatchStart: (startAtMs, _matchId) => {
        // edge: client joins after MATCH_START — late-joiner stays in lobby and
        // sees a notice. They'll enter normally when onMatchStart fires next round.
        if (Date.now() > startAtMs) {
          this.setMultiplayerStatus("MATCH IN PROGRESS — WAIT FOR NEXT ROUND");
          return;
        }
        // Reset per-match state before starting.
        this.localFinished = false;
        this.matchTimerLastRenderedSec = -1;
        this.matchTimerWarningPlayed = false;
        this.matchTimerCriticalLastSec = -1;
        this.multiplayer.setLocalName(this.getLobbyDisplayName());
        this.hideEndScreen();
        this.hideMultiplayerPanel();
        this.startGame();
        this.countdownActive = true;
        this.showCountdown();
      },
      onCountdownComplete: () => {
        // Countdown elapsed — inputs become live. The GO! overlay hides itself
        // via the 400 ms timer scheduled in updateCountdownOverlay().
        this.countdownActive = false;
        this.showMatchTimer();
      },
      onPeerDied: (_userId) => {
        // End-condition logic is handled inside multiplayer.ts; no UI needed here.
      },
      onPeerFinished: (_userId) => {
        // End-condition logic is handled inside multiplayer.ts; no UI needed here.
      },
      onMatchEnded: (results) => {
        // Hide timer immediately — do NOT show frozen "00:00" on results screen.
        this.hideMatchTimer();
        this.hideCountdown();
        // Reset lobby status text for late-joiners (who are still on lobby panel)
        // and for the next-round transition for all clients.
        // edge: late-join spectator state — clears "MATCH IN PROGRESS" notice so
        // the lobby shows the correct "Waiting for host…" / ready status.
        this.updateLobbyStatusText();
        // If still playing (player finished but didn't die), stop the game cleanly.
        if (this.state === GameState.Playing) {
          this.state = GameState.GameOver;
          stopMusic();
          stopAmbientTick();
          this.input.setTouchControlsVisible(false);
          this.hideTutorialOverlay(true);
          this.hideLandingCueHard();
          this.updateHud(dtZero());
          this.comboGlowOverlay.style.opacity = "0";
          this.clearScorePops();
          this.cameraDistancePulses.length = 0;
          this.comboFovPulseTimer = 0;
        }
        // edge: player edits name mid-match — peer names in results[] come from
        // peer.username which handleNameUpdate keeps current; local name is read
        // from localStorage so it's always the latest value too.
        const localName = this.getLobbyDisplayName();
        const resolvedResults = results.map((r) =>
          r.isLocal ? { ...r, name: localName } : r
        );
        this.showEndScreen(resolvedResults);
        // Rank-reveal stinger — only fires in multiplayer; solo path is untouched.
        if (this.multiplayer.isActive()) {
          const localResult = resolvedResults.find((r) => r.isLocal);
          if (localResult) {
            if (localResult.rank === 1) {
              playRankRevealVictory();
            } else {
              playRankRevealNeutral();
            }
          }
        }
      },
      onLobbyCancelled: () => {
        // edge: host disconnects in lobby — clear any orphaned countdown overlay
        // (carry-forward from Session 4: mid-countdown leak), then return to title.
        this.hideCountdown();
        this.countdownActive = false;
        this.hideMultiplayerPanel();
        void this.multiplayer.leaveLobby();
        this.showMpToast("HOST DISCONNECTED — LOBBY CLOSED", 3000);
      },
      onPeerLeft: (userId) => {
        // Refresh the lobby player list whenever a peer departs.
        this.renderPlayerList();
        // edge: host disconnects mid-match — match continues (seed and start
        // anchor are already known). Show a 1-shot toast; do NOT cancel the match.
        if (
          this.multiplayer.getMatchState() === "in_match" &&
          this.multiplayer.getHostUserId() === userId
        ) {
          this.showMpToast("HOST DISCONNECTED — MATCH CONTINUES", 4000);
        }
      },
    });
  }

  private async openMultiplayerLobby(): Promise<void> {
    if (!this.multiplayer.isAvailable()) return;
    if (this.multiplayer.isActive()) {
      this.showMultiplayerPanel();
      return;
    }
    this.setMultiplayerStatus("CREATING LOBBY…");
    this.showMultiplayerPanel();
    const id = await this.multiplayer.createLobby();
    if (!id) {
      this.setMultiplayerStatus("FAILED TO CREATE LOBBY");
      return;
    }
    this.multiplayerInviteUrl = await this.multiplayer.getInviteLink();
    this.refreshMultiplayerPanel();
  }

  private async joinMultiplayerFromLaunch(lobbyId: string): Promise<void> {
    this.showMultiplayerPanel();
    this.setMultiplayerStatus("JOINING LOBBY…");
    const ok = await this.multiplayer.joinLobby(lobbyId);
    if (!ok) {
      this.setMultiplayerStatus("FAILED TO JOIN LOBBY");
      return;
    }
    this.multiplayerInviteUrl = await this.multiplayer.getInviteLink();
    this.refreshMultiplayerPanel();
  }

  private async copyInviteLink(): Promise<void> {
    if (!this.multiplayerInviteUrl) {
      this.multiplayerInviteUrl = await this.multiplayer.getInviteLink();
    }
    const link = this.multiplayerInviteUrl;
    if (!link) {
      this.setMultiplayerStatus("INVITE LINK UNAVAILABLE");
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
        this.setMultiplayerStatus("LINK COPIED!");
        setTimeout(() => this.refreshMultiplayerPanel(), 1500);
        return;
      }
    } catch {
      // fall through to prompt fallback
    }
    try {
      window.prompt("Copy this invite link:", link);
    } catch {
      // ignore
    }
  }

  private async leaveMultiplayer(): Promise<void> {
    // edge: mid-countdown leak — if the local player leaves while a countdown
    // is active, clear the overlay so it doesn't stay on screen after leaving.
    this.hideCountdown();
    this.countdownActive = false;
    await this.multiplayer.leaveLobby();
    this.clearGhostMeshes();
    this.multiplayerInviteUrl = null;
    this.hideMultiplayerPanel();
  }

  private showMultiplayerPanel() {
    if (!this.multiplayerPanel) return;
    // Restore name input to current persisted display name
    if (this.multiplayerNameInput) {
      this.multiplayerNameInput.value = this.getLobbyDisplayName();
    }
    this.multiplayerPanel.style.display = "flex";
    this.multiplayerLobbyVisible = true;
    this.refreshMultiplayerPanel();
    this.startLobbyPolling();
  }

  private hideMultiplayerPanel() {
    if (!this.multiplayerPanel) return;
    this.stopLobbyPolling();
    if (this.multiplayerNameDebounceHandle !== null) {
      clearTimeout(this.multiplayerNameDebounceHandle);
      this.multiplayerNameDebounceHandle = null;
    }
    this.multiplayerPanel.style.display = "none";
    this.multiplayerLobbyVisible = false;
  }

  // ── Multiplayer countdown overlay ──────────────────────────────────────────

  /** Builds and appends the full-screen countdown DOM overlay (lazy, called on first show). */
  private createCountdownOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "900",
      background: "rgba(0, 0, 0, 0.5)",
      backdropFilter: "blur(6px)",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      pointerEvents: "none",
    } as CSSStyleDeclaration);

    const text = document.createElement("div");
    Object.assign(text.style, {
      fontSize: "clamp(80px, 18vw, 160px)",
      fontWeight: "900",
      color: "#ffe19d",
      textShadow: "0 0 40px rgba(255, 180, 60, 0.7), 0 4px 20px rgba(0, 0, 0, 0.7)",
      letterSpacing: "-0.02em",
      textAlign: "center",
      lineHeight: "1",
    } as CSSStyleDeclaration);
    text.dataset.role = "countdown-text";

    overlay.appendChild(text);
    document.body.appendChild(overlay);
    return overlay;
  }

  private showCountdown(): void {
    if (!this.multiplayerCountdownOverlay) {
      this.multiplayerCountdownOverlay = this.createCountdownOverlay();
    }
    this.countdownLastRenderedSec = -1;
    this.multiplayerCountdownOverlay.style.display = "flex";
  }

  private hideCountdown(): void {
    if (this.multiplayerCountdownOverlay) {
      this.multiplayerCountdownOverlay.style.display = "none";
    }
    if (this.countdownGoTimer !== null) {
      clearTimeout(this.countdownGoTimer);
      this.countdownGoTimer = null;
    }
    this.countdownLastRenderedSec = -1;
  }

  /**
   * Called each frame while countdownActive. Polls getCountdownMsRemaining()
   * and updates the overlay text only when the displayed integer second changes,
   * avoiding per-frame DOM writes. Plays audio cues on each second transition
   * and schedules the overlay hide ~400 ms after "GO!" appears.
   */
  private updateCountdownOverlay(): void {
    const remaining = this.multiplayer.getCountdownMsRemaining();
    if (remaining === null || !this.multiplayerCountdownOverlay) return;

    const textEl = this.multiplayerCountdownOverlay.querySelector(
      "[data-role='countdown-text']"
    ) as HTMLElement | null;
    if (!textEl) return;

    let label: string;
    let renderedSec: number;

    if (remaining > 0) {
      renderedSec = Math.ceil(remaining / 1000); // 3, 2, 1
      label = String(renderedSec);
    } else {
      renderedSec = 0;
      label = "GO!";
    }

    if (renderedSec !== this.countdownLastRenderedSec) {
      this.countdownLastRenderedSec = renderedSec;
      textEl.textContent = label;

      if (renderedSec > 0) {
        // Short 220 Hz beep on each second tick
        if (getAudioEnabled()) playTone(220, 0.08, "sine", 0.12);
      } else {
        // 440 Hz chime when GO! appears
        if (getAudioEnabled()) playTone(440, 0.15, "sine", 0.15);
        // Schedule overlay hide ~400 ms after GO! — only once
        if (this.countdownGoTimer === null) {
          this.countdownGoTimer = window.setTimeout(() => {
            this.countdownGoTimer = null;
            this.hideCountdown();
          }, 400);
        }
      }
    }
  }

  private setMultiplayerStatus(text: string) {
    if (this.multiplayerStatus) {
      this.multiplayerStatus.textContent = text;
    }
  }

  // ── Match timer HUD ────────────────────────────────────────────────────────

  /**
   * Injects CSS keyframe animations for the match timer once and returns the
   * outer container div. Called lazily on first show.
   */
  private createMatchTimerOverlay(): HTMLDivElement {
    if (!document.getElementById("cc-timer-styles")) {
      const style = document.createElement("style");
      style.id = "cc-timer-styles";
      style.textContent = `
        @keyframes cc-timer-warn-pulse {
          0%, 100% { transform: scale(1.0); }
          50%       { transform: scale(1.08); }
        }
        @keyframes cc-timer-crit-flash {
          0%, 100% { transform: scale(1.0); opacity: 0.4; }
          50%       { transform: scale(1.15); opacity: 1.0; }
        }
        .cc-timer-warning { animation: cc-timer-warn-pulse 1s ease-in-out infinite; }
        .cc-timer-critical { animation: cc-timer-crit-flash 0.5s ease-in-out infinite; }
      `;
      document.head.appendChild(style);
    }

    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      top: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "800",
      pointerEvents: "none",
      display: "none",
      textAlign: "center",
    } as CSSStyleDeclaration);

    const text = document.createElement("div");
    Object.assign(text.style, {
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "clamp(36px, 5vw, 64px)",
      fontWeight: "900",
      color: "#cfeaff",
      textShadow: "0 0 20px rgba(120, 210, 255, 0.5), 0 2px 12px rgba(0,0,0,0.7)",
      letterSpacing: "0.05em",
      lineHeight: "1",
      display: "inline-block",
    } as CSSStyleDeclaration);
    text.dataset.role = "timer-text";
    container.appendChild(text);

    document.body.appendChild(container);
    return container;
  }

  private showMatchTimer(): void {
    if (!this.matchTimerOverlay) {
      this.matchTimerOverlay = this.createMatchTimerOverlay();
    }
    this.matchTimerLastRenderedSec = -1;
    this.matchTimerWarningPlayed = false;
    this.matchTimerCriticalLastSec = -1;
    this.matchTimerOverlay.style.display = "block";
  }

  private hideMatchTimer(): void {
    if (this.matchTimerOverlay) {
      this.matchTimerOverlay.style.display = "none";
    }
  }

  /**
   * Updates the match timer DOM each frame. Only writes to DOM on integer-second
   * boundaries; uses CSS keyframe classes for animation (no rAF loop needed).
   */
  private updateMatchTimerOverlay(): void {
    if (!this.matchTimerOverlay || this.matchTimerOverlay.style.display === "none") return;

    const localStartAt = this.multiplayer.getLocalStartAt();
    if (localStartAt === 0) return;

    const elapsed = Date.now() - localStartAt;
    const secondsLeft = Math.max(0, 120 - Math.floor(elapsed / 1000));

    // Only update DOM on integer-second boundary.
    if (secondsLeft === this.matchTimerLastRenderedSec) return;
    this.matchTimerLastRenderedSec = secondsLeft;

    const textEl = this.matchTimerOverlay.querySelector("[data-role='timer-text']") as HTMLElement | null;
    if (!textEl) return;

    const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
    const ss = String(secondsLeft % 60).padStart(2, "0");
    textEl.textContent = `${mm}:${ss}`;

    if (secondsLeft >= 31) {
      // Calm state
      textEl.style.color = "#cfeaff";
      textEl.classList.remove("cc-timer-warning", "cc-timer-critical");
    } else if (secondsLeft >= 11) {
      // Warning state: amber + 1 Hz pulse
      textEl.style.color = "#ffb84a";
      textEl.classList.remove("cc-timer-critical");
      textEl.classList.add("cc-timer-warning");
      // Play entry tick once (when first entering warning zone)
      if (!this.matchTimerWarningPlayed) {
        this.matchTimerWarningPlayed = true;
        if (getAudioEnabled()) playTone(330, 0.08, "sine", 0.14);
      }
    } else if (secondsLeft >= 1) {
      // Critical state: red + 2 Hz flash
      textEl.style.color = "#ff5555";
      textEl.classList.remove("cc-timer-warning");
      textEl.classList.add("cc-timer-critical");
      // Rising-pitch tick on each new critical second
      if (secondsLeft !== this.matchTimerCriticalLastSec) {
        this.matchTimerCriticalLastSec = secondsLeft;
        if (getAudioEnabled()) {
          const freq = 440 + (10 - secondsLeft) * 30;
          playTone(freq, 0.1, "sine", 0.16);
        }
      }
    } else {
      // Zero — final flash, freeze display
      textEl.style.color = "#ff5555";
      textEl.style.opacity = "1";
      textEl.classList.remove("cc-timer-warning", "cc-timer-critical");
    }
  }

  // ── End-screen DOM ─────────────────────────────────────────────────────────

  private createEndScreen(): HTMLDivElement {
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0, 0, 0, 0.6)",
      backdropFilter: "blur(8px)",
      zIndex: "950",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
    } as CSSStyleDeclaration);
    backdrop.dataset.role = "end-screen";

    const card = document.createElement("div");
    Object.assign(card.style, {
      background: "linear-gradient(180deg, rgba(14, 28, 40, 0.97), rgba(6, 14, 22, 0.92))",
      border: "1px solid rgba(127, 214, 255, 0.28)",
      borderRadius: "18px",
      padding: "28px 24px 22px",
      width: "min(480px, calc(100vw - 32px))",
      boxSizing: "border-box",
      boxShadow: "0 20px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(173,232,255,0.12)",
      color: "#d7f8ff",
      overflowY: "auto",
      maxHeight: "calc(100vh - 32px)",
    } as CSSStyleDeclaration);
    card.addEventListener("click", (e) => e.stopPropagation());

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    return backdrop;
  }

  /** Populates and shows the end screen with the given match results. */
  private showEndScreen(results: MatchResult[]): void {
    if (!this.endScreenOverlay) {
      this.endScreenOverlay = this.createEndScreen();
    }
    const backdrop = this.endScreenOverlay;
    const card = backdrop.firstElementChild as HTMLDivElement;
    card.innerHTML = "";

    const anyFinished = results.some((r) => r.finished);

    // ── Header ───────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    Object.assign(header.style, {
      fontSize: "14px",
      fontWeight: "700",
      letterSpacing: "2px",
      color: "#ffc878",
      textAlign: "center",
      marginBottom: "6px",
    } as CSSStyleDeclaration);
    header.textContent = "RESULTS — Race to 100 m";
    card.appendChild(header);

    // edge: match end with 0 finishers, all dead — show "NO ONE MADE IT" sub-header.
    if (!anyFinished) {
      const sub = document.createElement("div");
      Object.assign(sub.style, {
        fontSize: "11px",
        letterSpacing: "1.5px",
        color: "#7fd6ff",
        textAlign: "center",
        fontStyle: "italic",
        marginBottom: "16px",
        opacity: "0.8",
      } as CSSStyleDeclaration);
      sub.textContent = "NO ONE MADE IT";
      card.appendChild(sub);
    } else {
      header.style.marginBottom = "16px";
    }

    // ── Results table ────────────────────────────────────────────────────────
    const table = document.createElement("div");
    Object.assign(table.style, {
      width: "100%",
      marginBottom: "20px",
      borderRadius: "10px",
      overflow: "hidden",
      border: "1px solid rgba(127, 214, 255, 0.12)",
    } as CSSStyleDeclaration);

    // Column header row
    const colHeader = document.createElement("div");
    Object.assign(colHeader.style, {
      display: "grid",
      gridTemplateColumns: "36px 1fr 72px 60px 80px",
      gap: "0",
      padding: "6px 10px",
      background: "rgba(127, 214, 255, 0.07)",
      fontSize: "9px",
      letterSpacing: "1.5px",
      color: "#7fd6ff",
      fontWeight: "700",
    } as CSSStyleDeclaration);
    ["#", "PLAYER", "SCORE", "HEIGHT", "TIME"].forEach((col) => {
      const cell = document.createElement("div");
      cell.textContent = col;
      colHeader.appendChild(cell);
    });
    table.appendChild(colHeader);

    // Data rows
    for (const r of results) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "36px 1fr 72px 60px 80px",
        gap: "0",
        padding: "8px 10px",
        background: r.isLocal ? "rgba(127, 214, 255, 0.06)" : "transparent",
        borderTop: "1px solid rgba(127, 214, 255, 0.08)",
        fontSize: "12px",
        alignItems: "center",
        boxSizing: "border-box",
      } as CSSStyleDeclaration);
      if (r.isLocal) {
        row.style.outline = "2px solid #ffd966";
        row.style.outlineOffset = "-2px";
        row.style.borderRadius = "6px";
      }

      // Rank column
      const rankCell = document.createElement("div");
      rankCell.textContent = r.rank === 1 ? "👑" : String(r.rank);
      Object.assign(rankCell.style, { color: r.rank === 1 ? "#ffd966" : "#7fd6ff", fontWeight: "700" } as CSSStyleDeclaration);
      row.appendChild(rankCell);

      // Player name
      const nameCell = document.createElement("div");
      nameCell.textContent = r.name;
      Object.assign(nameCell.style, {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: r.isLocal ? "#d7f8ff" : "#a8d8f0",
        paddingRight: "8px",
      } as CSSStyleDeclaration);
      row.appendChild(nameCell);

      // Score
      const scoreCell = document.createElement("div");
      scoreCell.textContent = String(r.score);
      Object.assign(scoreCell.style, { color: "#cfeaff" } as CSSStyleDeclaration);
      row.appendChild(scoreCell);

      // Height
      const heightCell = document.createElement("div");
      heightCell.textContent = `${Math.floor(r.height)}m`;
      Object.assign(heightCell.style, { color: "#a8d8f0" } as CSSStyleDeclaration);
      row.appendChild(heightCell);

      // Time
      const timeCell = document.createElement("div");
      if (r.isDnf) {
        timeCell.textContent = "DNF";
        timeCell.style.color = "#ff7070";
      } else if (r.finished && r.finishMs !== undefined) {
        const totalMs = r.finishMs;
        const mins = Math.floor(totalMs / 60_000);
        const secs = Math.floor((totalMs % 60_000) / 1000);
        const ms = totalMs % 1000;
        timeCell.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
        timeCell.style.color = "#7ff0a0";
      } else {
        timeCell.textContent = "—";
        timeCell.style.color = "#7fd6ff";
      }
      row.appendChild(timeCell);

      table.appendChild(row);
    }
    card.appendChild(table);

    // ── Buttons ──────────────────────────────────────────────────────────────
    const makeBtn = (label: string, accent: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      Object.assign(b.style, {
        padding: "10px 20px",
        borderRadius: "999px",
        border: `1px solid ${accent}`,
        background: "linear-gradient(180deg, rgba(18,32,46,0.92), rgba(8,16,24,0.82))",
        color: "#d7f8ff",
        cursor: "pointer",
        fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
        fontSize: "12px",
        fontWeight: "700",
        letterSpacing: "2px",
      } as CSSStyleDeclaration);
      return b;
    };

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, {
      display: "flex",
      gap: "10px",
      justifyContent: "center",
      flexWrap: "wrap",
    } as CSSStyleDeclaration);

    const isHost = this.multiplayer.isHost();

    if (isHost) {
      const startBtn = makeBtn("Cooldown…", "rgba(255,196,120,0.4)");
      startBtn.disabled = true;
      startBtn.style.opacity = "0.5";
      startBtn.style.cursor = "not-allowed";
      // Enable after 3 s cooldown
      window.setTimeout(() => {
        if (startBtn.isConnected) {
          startBtn.textContent = "START NEXT MATCH";
          startBtn.disabled = false;
          startBtn.style.opacity = "1";
          startBtn.style.cursor = "pointer";
        }
      }, 3000);
      startBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Reset for next match and start — onMatchStart will hide the end screen.
        this.multiplayer.resetForNextMatch();
        this.multiplayer.startMatch();
      });
      btnRow.appendChild(startBtn);
    } else {
      const waitText = document.createElement("div");
      Object.assign(waitText.style, {
        fontSize: "11px",
        letterSpacing: "1px",
        color: "#7fd6ff",
        alignSelf: "center",
        opacity: "0.8",
      } as CSSStyleDeclaration);
      waitText.textContent = "Waiting for host to start next match…";
      btnRow.appendChild(waitText);
    }

    const leaveBtn = makeBtn("LEAVE LOBBY", "rgba(255,120,120,0.4)");
    leaveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideEndScreen();
      this.hideMatchTimer();
      // If still in Playing state (player finished but didn't die), stop.
      if (this.state === GameState.Playing) {
        this.state = GameState.GameOver;
        stopMusic();
        stopAmbientTick();
      }
      void this.leaveMultiplayer().then(() => {
        this.returnToTitle();
      });
    });
    btnRow.appendChild(leaveBtn);

    card.appendChild(btnRow);

    backdrop.style.display = "flex";
  }

  private hideEndScreen(): void {
    if (this.endScreenOverlay) {
      this.endScreenOverlay.style.display = "none";
    }
  }

  private refreshMultiplayerPanel() {
    if (!this.multiplayerPanel || !this.multiplayerLobbyVisible) return;
    if (!this.multiplayer.isActive()) {
      this.setMultiplayerStatus("Creating lobby…");
      return;
    }
    this.renderPlayerList();
    this.updateStartButtonState();
    this.updateInviteLinkField();
    this.updateLobbyStatusText();
  }

  // ── Lobby display helpers ─────────────────────────────────────────────────

  /** Returns the lobby-specific display name (cc.displayName), falling back to the coolname. */
  private getLobbyDisplayName(): string {
    try {
      const stored = localStorage.getItem("cc.displayName");
      if (stored && stored.trim().length > 0) return stored.trim();
    } catch { /* localStorage unavailable */ }
    return this.getLocalUsername();
  }

  /** Persists the lobby display name to localStorage. */
  private setLobbyDisplayName(name: string): void {
    try {
      localStorage.setItem("cc.displayName", name);
    } catch { /* ignore */ }
  }

  /** Re-renders the player list rows (self first, then peers). */
  private renderPlayerList(): void {
    const list = this.multiplayerPlayerList;
    if (!list) return;

    list.innerHTML = "";

    const selfIsHost = this.multiplayer.isHost();
    const hostUserId = this.multiplayer.getHostUserId();
    const peers = this.multiplayer.getPeers();

    // Self row (always first)
    list.appendChild(this.makePlayerRow(this.getLobbyDisplayName(), true, selfIsHost));

    // Peer rows (up to 3 so total stays ≤ 4)
    for (const peer of peers.slice(0, 3)) {
      const peerIsHost = !selfIsHost && peer.userId === hostUserId;
      list.appendChild(this.makePlayerRow(peer.username, false, peerIsHost));
    }
  }

  /** Builds a single player-list row element. */
  private makePlayerRow(name: string, isSelf: boolean, isHost: boolean): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "5px 8px",
      borderRadius: "8px",
      background: isSelf ? "rgba(127, 214, 255, 0.08)" : "rgba(0, 0, 0, 0.15)",
      fontSize: "12px",
      minHeight: "28px",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    if (isHost) {
      const crown = document.createElement("span");
      crown.textContent = "👑";
      Object.assign(crown.style, { fontSize: "12px", lineHeight: "1", flexShrink: "0" } as CSSStyleDeclaration);
      row.appendChild(crown);
    }

    const nameSpan = document.createElement("span");
    nameSpan.textContent = name;
    Object.assign(nameSpan.style, {
      flex: "1",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: isSelf ? "#d7f8ff" : "#a8d8f0",
    } as CSSStyleDeclaration);
    row.appendChild(nameSpan);

    if (isSelf) {
      const youTag = document.createElement("span");
      youTag.textContent = "(you)";
      Object.assign(youTag.style, {
        color: "#7fd6ff",
        fontSize: "10px",
        letterSpacing: "1px",
        opacity: "0.7",
        flexShrink: "0",
      } as CSSStyleDeclaration);
      row.appendChild(youTag);
    }

    return row;
  }

  /** Enables/disables (and shows/hides) the START MATCH button based on host status and peer count. */
  private updateStartButtonState(): void {
    const btn = this.multiplayerStartBtn;
    if (!btn) return;
    const isHost = this.multiplayer.isHost();
    btn.style.display = isHost ? "" : "none";
    if (!isHost) return;
    const canStart = this.multiplayer.getPeerCount() >= 1;
    (btn as HTMLButtonElement).disabled = !canStart;
    btn.title = canStart ? "" : "Waiting for at least 1 other player";
    btn.style.opacity = canStart ? "1" : "0.45";
    btn.style.cursor = canStart ? "pointer" : "not-allowed";
  }

  /** Updates status text based on current match state. */
  private updateLobbyStatusText(): void {
    const state = this.multiplayer.getMatchState();
    if (state === "countdown") {
      this.setMultiplayerStatus("Match starting…");
      return;
    }
    if (state === "in_match") {
      this.setMultiplayerStatus("Match in progress — you'll join the next round");
      return;
    }
    // "lobby" or "ended"
    if (this.multiplayer.isHost()) {
      this.setMultiplayerStatus(
        this.multiplayer.getPeerCount() >= 1
          ? "Ready — press START MATCH when everyone is here"
          : "Share the invite link to bring in players"
      );
    } else {
      this.setMultiplayerStatus("Waiting for host…");
    }
  }

  /** Populates the invite link readonly field once the URL is available. */
  private updateInviteLinkField(): void {
    if (this.multiplayerInviteLinkField && this.multiplayerInviteUrl) {
      this.multiplayerInviteLinkField.value = this.multiplayerInviteUrl;
    }
  }

  /** Starts the 300 ms lobby-poll that refreshes the player list and button state. */
  private startLobbyPolling(): void {
    this.stopLobbyPolling();
    this.multiplayerPollHandle = window.setInterval(() => {
      if (!this.multiplayerLobbyVisible) return;
      this.renderPlayerList();
      this.updateStartButtonState();
      this.updateInviteLinkField();
      if (this.multiplayer.isActive()) this.updateLobbyStatusText();
    }, 300);
  }

  /** Stops the lobby poll. */
  private stopLobbyPolling(): void {
    if (this.multiplayerPollHandle !== null) {
      clearInterval(this.multiplayerPollHandle);
      this.multiplayerPollHandle = null;
    }
  }

  private ensureGhostVisual(peer: PeerGhost, index: number): GhostVisual {
    const existing = this.ghostMeshes.get(peer.userId);
    if (existing) return existing;

    const colorHex = GHOST_COLORS[index % GHOST_COLORS.length];
    const group = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 12);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.8,
      metalness: 0.3,
      roughness: 0.35,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.3;
    group.add(body);

    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.9,
    });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.1, 0.45, 0.25);
    group.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.1, 0.45, 0.25);
    group.add(rightEye);

    this.ghostGroup.add(group);

    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "absolute",
      transform: "translate(-50%, -100%)",
      padding: "3px 8px",
      borderRadius: "8px",
      background: "rgba(8, 12, 18, 0.65)",
      border: `1px solid #${colorHex.toString(16).padStart(6, "0")}`,
      color: "#f3faff",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "11px",
      letterSpacing: "1px",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    label.textContent = peer.username;
    if (this.multiplayerLabelLayer) {
      this.multiplayerLabelLayer.appendChild(label);
    }

    const visual: GhostVisual = {
      group,
      body,
      bodyMaterial: bodyMat,
      eyes: [leftEye, rightEye],
      label,
      colorHex,
    };
    this.ghostMeshes.set(peer.userId, visual);
    return visual;
  }

  private disposeGhostVisual(userId: string) {
    const visual = this.ghostMeshes.get(userId);
    if (!visual) return;
    this.ghostGroup.remove(visual.group);
    visual.body.geometry.dispose();
    visual.bodyMaterial.dispose();
    for (const eye of visual.eyes) {
      eye.geometry.dispose();
      (eye.material as THREE.Material).dispose();
    }
    if (visual.label.parentElement) {
      visual.label.parentElement.removeChild(visual.label);
    }
    this.ghostMeshes.delete(userId);
  }

  private clearGhostMeshes() {
    const userIds = Array.from(this.ghostMeshes.keys());
    for (const userId of userIds) {
      this.disposeGhostVisual(userId);
    }
  }

  private updateGhosts(dt: number) {
    const peers = this.multiplayer.getPeers();
    const seen = new Set<string>();
    peers.forEach((peer, index) => {
      seen.add(peer.userId);
      const visual = this.ensureGhostVisual(peer, index);

      const clock = this.multiplayer.getClock();
      const span = Math.max(0.02, peer.lastUpdate - peer.prevUpdate);
      const t = THREE.MathUtils.clamp((clock - peer.lastUpdate) / span + 1, 0, 1.25);
      const x = THREE.MathUtils.lerp(peer.prevX, peer.x, t);
      const y = THREE.MathUtils.lerp(peer.prevY, peer.y, t);
      const z = THREE.MathUtils.lerp(peer.prevZ, peer.z, t);
      visual.group.position.set(x, y, z);
      visual.group.rotation.y += dt * 0.6;

      if (this.multiplayerLabelLayer) {
        this.ghostTmpVec.set(x, y + 0.9, z);
        this.ghostTmpVec.project(this.camera);
        const halfW = this.multiplayerLabelLayer.clientWidth * 0.5;
        const halfH = this.multiplayerLabelLayer.clientHeight * 0.5;
        const onScreen =
          this.ghostTmpVec.z > -1 &&
          this.ghostTmpVec.z < 1 &&
          Math.abs(this.ghostTmpVec.x) < 1.2 &&
          Math.abs(this.ghostTmpVec.y) < 1.2;
        if (onScreen) {
          const screenX = halfW + this.ghostTmpVec.x * halfW;
          const screenY = halfH - this.ghostTmpVec.y * halfH;
          visual.label.style.display = "block";
          visual.label.style.left = `${screenX}px`;
          visual.label.style.top = `${screenY}px`;
          visual.label.textContent = `${peer.username} · ${peer.score}`;
        } else {
          visual.label.style.display = "none";
        }
      }
    });

    const existingIds = Array.from(this.ghostMeshes.keys());
    for (const userId of existingIds) {
      if (!seen.has(userId)) {
        this.disposeGhostVisual(userId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // AI Ghost (RL-trained agent playing alongside)
  // -----------------------------------------------------------------------

  private initAIGhost(): void {
    if (!this.aiGhostEnabled || this.isDailyChallenge) return;
    this.aiGhost = new AIGhost(getAIGhostModelUrl());
    void this.aiGhost.load().then((ok) => {
      if (ok) console.log("[game] AI ghost ready");
    });
  }

  private setupAIGhostButton(): void {
    // The scripted AI ghost was pulled (2026-04-23) because it gets stuck on
    // gear layouts where one gear occludes the direct jump path to another.
    // The replacement is a human-recorded ghost (see "PLAY A GHOST" below).
    //
    // The scripted / ONNX / MLP code paths stay in the repo as dev-only
    // fallbacks via the `?_ai=1|onnx|mlp` query params — they're useful for
    // debugging, just not shipped in the title-screen UI.
    const AI_GHOST_READY = false;

    const btn = document.getElementById("title-btn-raceai") as HTMLButtonElement | null;
    if (!btn) return;
    this.aiGhostButton = btn;

    // ----- PLAY A GHOST (human playback challenge) -----
    //
    // Ghost source: the remote multi-game ghost pool at
    //   https://api.tommyato.com/games/clockwork-climb/ghosts
    // On init we fetch up to 5 ghosts and pick one at random per session.
    //
    // The button stays hidden until `setupGhostChallenge` confirms a ghost
    // was successfully fetched — so a failed fetch won't strand a dead
    // button on the title screen.
    const GHOST_CHALLENGE_READY = true;

    if (!AI_GHOST_READY && !GHOST_CHALLENGE_READY) {
      btn.style.display = "none";
      return;
    }

    if (AI_GHOST_READY) {
      // Legacy scripted-AI path (unused in production). Left for reference.
      btn.textContent = this.aiGhostEnabled ? "AI: ON" : "RACE AI";
      Object.assign(btn.style, {
        border: "1px solid rgba(255, 196, 120, 0.45)",
        background: "linear-gradient(180deg, rgba(46, 32, 14, 0.92), rgba(24, 16, 8, 0.82))",
        boxShadow: "0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255, 226, 176, 0.18)",
        color: "#ffe1a9",
      } as CSSStyleDeclaration);
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.handleAIGhostButtonClick();
      });
      btn.addEventListener("touchend", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.handleAIGhostButtonClick();
      }, { passive: false });
      return;
    }

    // Challenge mode — button is revealed by setupGhostChallenge once a remote
    // ghost is loaded. Hidden by default so a failed fetch leaves a clean title.
    btn.textContent = "PLAY A GHOST";
    Object.assign(btn.style, {
      border: "1px solid rgba(155, 216, 255, 0.45)",
      background: "linear-gradient(180deg, rgba(14, 30, 46, 0.92), rgba(8, 16, 28, 0.82))",
      boxShadow: "0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(173, 232, 255, 0.18)",
      color: "#d7f8ff",
    } as CSSStyleDeclaration);
    btn.style.display = "none";

    const startChallenge = () => {
      if (this.state !== GameState.Title && this.state !== GameState.GameOver) return;
      if (!this.ghostChallengeRecord) return;
      this.isChallengeMode = true;
      this.startGame();
    };
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startChallenge();
    });
    btn.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startChallenge();
    }, { passive: false });
  }

  /**
   * Fetch up to 5 ghosts from the remote pool and pick one at random.
   * If the pool returns nothing the PLAY A GHOST button stays hidden.
   * Called once at init.
   */
  private async setupGhostChallenge(): Promise<void> {
    const remote = await fetchRemoteGhosts(5);
    const picked = pickRandomGhost(remote);
    if (picked) {
      this.ghostChallengeRecord = picked;
      if (this.aiGhostButton) this.aiGhostButton.style.display = "inline-flex";
      console.log(
        `[game] Ghost challenge loaded (remote) — ${picked.name} · ${picked.height}m · ${picked.frames.length} frames (pool size ${remote.length})`,
      );
    }
  }

  /**
   * Wire up the username input field on the title screen.
   * Storage key is cc-username via coolname.ts.
   */
  private setupUsernameUi(): void {
    const input = document.getElementById("title-username-input") as HTMLInputElement | null;
    if (!input) return;
    input.value = this.getLocalUsername();
    const commit = () => {
      setCoolLocalUsername(input.value);
      input.value = this.getLocalUsername();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      // Stop key events from reaching the game while the input is focused.
      e.stopPropagation();
    });
    // Also suppress keyup/keypress so wasd / arrows don't move the player.
    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("keypress", (e) => e.stopPropagation());
    // Prevent the title-overlay click handler from triggering play.
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("touchend", (e) => e.stopPropagation());
  }

  /**
   * Sync the title-screen username input to the current persisted name.
   */
  private refreshUsernameUi(): void {
    const input = document.getElementById("title-username-input") as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = this.getLocalUsername();
  }

  private async handleAIGhostButtonClick(): Promise<void> {
    const btn = this.aiGhostButton;
    if (!btn) return;

    if (this.aiGhostEnabled) {
      // Toggle OFF — use "AI GHOST: OFF" once the model has been initialized
      this.aiGhostEnabled = false;
      btn.textContent = this.aiGhost ? "AI GHOST: OFF" : "RACE THE AI";
      // Remove ghost mesh if it exists
      this.disposeGhostVisual("__ai_ghost__");
      return;
    }

    // Toggle ON
    this.aiGhostEnabled = true;

    if (!this.aiGhost) {
      this.aiGhost = new AIGhost(getAIGhostModelUrl());
    }

    if (!this.aiGhost.isReady()) {
      btn.textContent = "LOADING AI...";
      btn.style.cursor = "default";
      btn.style.opacity = "0.65";

      const ok = await this.aiGhost.load();

      btn.style.opacity = "1";
      btn.style.cursor = "pointer";

      if (!ok) {
        this.aiGhostEnabled = false;
        btn.textContent = "RACE THE AI";
        return;
      }
    }

    btn.textContent = "AI GHOST: ON";

    // Launch the run immediately
    if (this.state === GameState.Title || this.state === GameState.GameOver) {
      this.startGame();
    }
  }

  private resetAIGhost(): void {
    if (!this.aiGhostEnabled || !this.aiGhost?.isReady()) return;
    // Seed priority: daily > challenge mode > multiplayer > regular.
    // The AI ghost must run on the same tower as the player.
    let seed: number;
    if (this.isDailyChallenge) {
      seed = dailySeed(this.dailyChallengeDate);
    } else if (this.isChallengeMode) {
      seed = this.ghostChallengeRecord?.seed ?? CHALLENGE_SEED;
    } else {
      const mpSeed = this.multiplayer.isActive() ? this.multiplayer.getSyncedSeed() : null;
      seed = mpSeed ?? this.regularSeed;
    }
    this.aiGhost.reset(seed);
  }

  private updateAIGhost(dt: number): void {
    if (!this.aiGhostEnabled || !this.aiGhost?.isReady()) return;
    this.aiGhost.update(dt);
    const gs = this.aiGhost.getGhostState();
    if (!gs || !gs.alive) return;

    const AID = "__ai_ghost__";
    if (!this.ghostMeshes.has(AID)) {
      const c = 0xff4400;
      const grp = new THREE.Group();
      const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.6, 12);
      const mat = new THREE.MeshStandardMaterial({
        color: c, emissive: c, emissiveIntensity: 0.9,
        metalness: 0.3, roughness: 0.35, transparent: true, opacity: 0.35, depthWrite: false,
      });
      const body = new THREE.Mesh(geo, mat);
      body.position.y = 0.3;
      grp.add(body);
      const eGeo = new THREE.SphereGeometry(0.05, 8, 8);
      const eMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.9 });
      const lEye = new THREE.Mesh(eGeo, eMat);
      lEye.position.set(-0.1, 0.45, 0.25);
      grp.add(lEye);
      const rEye = new THREE.Mesh(eGeo, eMat);
      rEye.position.set(0.1, 0.45, 0.25);
      grp.add(rEye);
      this.ghostGroup.add(grp);

      const lbl = document.createElement("div");
      Object.assign(lbl.style, {
        position: "absolute", transform: "translate(-50%, -100%)",
        padding: "3px 8px", borderRadius: "8px",
        background: "rgba(8,12,18,0.65)", border: "1px solid #ff4400",
        color: "#ffcc88", fontFamily: 'ui-monospace,"Cascadia Code","Fira Code",monospace',
        fontSize: "11px", letterSpacing: "1px", whiteSpace: "nowrap", pointerEvents: "none",
      } as CSSStyleDeclaration);
      lbl.textContent = "AI";
      this.multiplayerLabelLayer?.appendChild(lbl);

      this.ghostMeshes.set(AID, { group: grp, body, bodyMaterial: mat, eyes: [lEye, rEye], label: lbl, colorHex: c });
    }

    const v = this.ghostMeshes.get(AID)!;
    v.group.position.set(gs.x, gs.y, gs.z);
    v.group.rotation.y += dt * 0.8;

    if (this.multiplayerLabelLayer) {
      this.ghostTmpVec.set(gs.x, gs.y + 0.9, gs.z);
      this.ghostTmpVec.project(this.camera);
      const hw = this.multiplayerLabelLayer.clientWidth * 0.5;
      const hh = this.multiplayerLabelLayer.clientHeight * 0.5;
      const vis = this.ghostTmpVec.z > -1 && this.ghostTmpVec.z < 1 &&
        Math.abs(this.ghostTmpVec.x) < 1.2 && Math.abs(this.ghostTmpVec.y) < 1.2;
      if (vis) {
        v.label.style.display = "block";
        v.label.style.left = `${hw + this.ghostTmpVec.x * hw}px`;
        v.label.style.top = `${hh - this.ghostTmpVec.y * hh}px`;
        v.label.textContent = `AI \u00B7 ${gs.score}`;
      } else {
        v.label.style.display = "none";
      }
    }
  }

  // -----------------------------------------------------------------------
  // PLAY A GHOST — recorder + playback session lifecycle
  // -----------------------------------------------------------------------

  /** Per-frame tick for the human-ghost recorder / playback. */
  private updateGhostSession(dt: number, state: SimState): void {
    if (this.ghostRecorder.isRecording()) {
      this.ghostRecorder.sample(state.player.x, state.player.y, state.player.z, state.player.onGround);
    }
    if (this.ghostPlayback) {
      this.ghostPlayback.update(dt);
    }
  }

  /**
   * Called from `finishGame`. Stops the recorder and submits the ghost to
   * the server if the run's score meets the leaderboard threshold. Submission
   * is fire-and-forget — failures are logged but don't block the game-over UI.
   */
  private finishGhostSession(): void {
    this.ghostRecorder.stop();
    const frameCount = this.ghostRecorder.frameCount;
    if (frameCount >= 2) {
      const record = this.ghostRecorder.buildRecord({
        id: `cc-${utcDateKey()}`,
        name: this.getLocalUsername(),
        seed: this.isChallengeMode
          ? CHALLENGE_SEED
          : this.multiplayer.isActive()
          ? (this.multiplayer.getSyncedSeed() ?? this.regularSeed)
          : this.regularSeed,
        score: this.score,
        height: this.heightMaxReached,
      });
      const { score } = record;
      // Gate server submission on the 10th-place leaderboard score. Returns 0
      // while the pool has fewer than 10 entries, so every early run qualifies.
      void fetchGhostUploadThreshold().then((threshold) => {
        if (score >= threshold) {
          void submitRemoteGhost({
            name: record.name,
            score: record.score,
            height: record.height,
            seed: record.seed,
            frames: record.frames,
          }).then((id) => {
            if (id) console.log(`[remote-ghosts] Submitted ghost — id=${id}, score=${score}, threshold=${threshold}`);
            else console.warn("[remote-ghosts] Ghost submission failed (network or 4xx).");
          });
        } else {
          console.log(`[ghost-recorder] Score ${score} below threshold ${threshold} — run recorded locally but not submitted.`);
        }
      });
    } else {
      console.warn(`[ghost-recorder] Not saving — only captured ${frameCount} frame(s).`);
    }
    if (this.ghostPlayback) {
      this.ghostPlayback.stop();
    }
    // Challenge mode is a one-shot — the user comes back to the title screen
    // and picks PLAY A GHOST again to re-run it, or PLAY for a fresh tower.
    this.isChallengeMode = false;
  }

  private async readSaveData(): Promise<SaveData> {
    const rawSave = await loadSaveData();
    const parsedSave = parseSaveData(rawSave);
    const statBackedSave: SaveData = {
      bestScore: parsedSave.bestScore,
      bestHeight: Math.max(parsedSave.bestHeight, getStat("highest_climb")),
      bestCombo: Math.max(parsedSave.bestCombo, getStat("best_combo")),
      totalRuns: Math.max(parsedSave.totalRuns, getStat("total_runs")),
      totalBolts: Math.max(parsedSave.totalBolts, getStat("total_bolts")),
      totalPlaytime: Math.max(parsedSave.totalPlaytime, getStat("total_playtime")),
      audioEnabled: parsedSave.audioEnabled,
    };
    return statBackedSave;
  }

  private resetVisualWorld() {
    // Return all active game gears to the pool (removes from scene; keeps for reuse).
    for (const gear of this.visualGearMap.values()) {
      this.gearPool.release(gear);
    }
    for (const bolt of this.visualBoltMap.values()) {
      this.scene.remove(bolt.mesh);
    }
    for (const mesh of this.visualPowerUpMap.values()) {
      this.scene.remove(mesh);
    }
    this.visualGearMap.clear();
    this.visualBoltMap.clear();
    this.visualPowerUpMap.clear();
    this.gears = [];
    this.bolts = [];
    this.gearTickNextTimes.clear();
    this.bouncyGearSquashTimers.clear();
    this.crumbleSfxArmed.clear();
    this.crumbleSfxFalling.clear();
    this.windGustNextTimes.clear();
    this.magnetPulseNextTimes.clear();
    this.backgroundGroup.clear();
    this.backgroundDecorations = [];
    this.clearTitleBackdrop();
    this.backgroundGenerationHeight = 0;
    this.particles.reset();
    this.clearScorePops();
    this.comboGlowOverlay.style.opacity = "0";
  }

  private buildTitleBackdrop() {
    this.clearTitleBackdrop();
    const configurations = [
      { x: -8.4, y: 3.4, z: -13.5, scale: 2.6, rotationSpeed: 0.024, radius: 3.2, color: 0xa16a34, variant: "normal" as GearVariant, bobAmplitude: 0.14, bobPhase: 0.2 },
      { x: -4.8, y: 6.2, z: -14.2, scale: 2.2, rotationSpeed: -0.034, radius: 2.5, color: 0xffa34d, variant: "speed" as GearVariant, bobAmplitude: 0.1, bobPhase: 1.4 },
      { x: 4.8, y: 6.2, z: -14.2, scale: 2.2, rotationSpeed: 0.034, radius: 2.5, color: 0x5d8fb3, variant: "wind" as GearVariant, bobAmplitude: 0.1, bobPhase: 2.6 },
      { x: 8.4, y: 3.4, z: -13.5, scale: 2.6, rotationSpeed: -0.024, radius: 3.2, color: 0x5aa95f, variant: "bouncy" as GearVariant, bobAmplitude: 0.14, bobPhase: 3.1 },
      { x: 0, y: 10.8, z: -17.5, scale: 3.5, rotationSpeed: 0.018, radius: 3.0, color: 0x8b63d0, variant: "magnetic" as GearVariant, bobAmplitude: 0.16, bobPhase: 4.2 },
    ];

    for (const config of configurations) {
      const gear = new Gear({
        color: config.color,
        height: 0.5,
        radius: config.radius,
        rotationSpeed: 0.12,
        variant: config.variant,
      });
      gear.enableTopDownShadow(this.topDownShadow.uniforms);
      gear.mesh.scale.setScalar(config.scale);
      gear.mesh.position.set(config.x, config.y, config.z);
      gear.mesh.rotation.x = config.x === 0 ? -0.08 : 0;
      gear.mesh.rotation.y = config.x === 0 ? 0 : Math.sign(config.x) * 0.12;
      this.styleBackdropGear(gear, 0.35);
      this.titleBackdropGroup.add(gear.mesh);
      this.titleBackdropDecorations.push({
        baseY: config.y,
        bobAmplitude: config.bobAmplitude,
        bobPhase: config.bobPhase,
        gear,
        mesh: gear.mesh,
        rotationSpeed: config.rotationSpeed,
      });
    }
  }

  private clearTitleBackdrop() {
    for (const decoration of this.titleBackdropDecorations) {
      this.titleBackdropGroup.remove(decoration.mesh);
    }
    this.titleBackdropDecorations = [];
    this.titleBackdropGroup.clear();
  }

  private setGearOpacity(gear: Gear, opacity: number) {
    gear.mesh.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      const material = object.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          this.applyGearMaterialOpacity(entry, opacity);
        }
        return;
      }
      this.applyGearMaterialOpacity(material, opacity);
    });
  }

  private applyGearMaterialOpacity(material: THREE.Material, opacity: number) {
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      return;
    }
    material.transparent = true;
    material.opacity = opacity;
    material.depthWrite = false;
  }

  private styleBackdropGear(gear: Gear, opacity: number) {
    gear.mesh.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      const material = object.material;
      if (Array.isArray(material)) {
        object.material = material.map((entry) => this.convertBackdropMaterial(entry, opacity));
        return;
      }

      object.material = this.convertBackdropMaterial(material, opacity);
    });
  }

  private convertBackdropMaterial(material: THREE.Material, opacity: number) {
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      return material;
    }

    const backdropMaterial = new THREE.MeshBasicMaterial({
      color: material.color.clone().multiplyScalar(1.25),
      transparent: true,
      opacity,
      depthWrite: false,
    });
    return backdropMaterial;
  }

  private addCameraDistancePulse(amount: number, attack: number, release: number) {
    this.cameraDistancePulses.push({
      amount,
      attack,
      elapsed: 0,
      release,
    });
  }

  private updateCameraDistancePulses(dt: number) {
    let offset = 0;
    for (let index = this.cameraDistancePulses.length - 1; index >= 0; index -= 1) {
      const pulse = this.cameraDistancePulses[index];
      pulse.elapsed += dt;
      const totalDuration = pulse.attack + pulse.release;
      if (pulse.elapsed >= totalDuration) {
        this.cameraDistancePulses.splice(index, 1);
        continue;
      }

      let envelope = 0;
      if (pulse.elapsed < pulse.attack) {
        envelope = pulse.elapsed / Math.max(pulse.attack, 0.001);
      } else {
        envelope = 1 - (pulse.elapsed - pulse.attack) / Math.max(pulse.release, 0.001);
      }
      offset += pulse.amount * THREE.MathUtils.clamp(envelope, 0, 1);
    }

    return offset;
  }

  private loop() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsedTime += dt;
    this.input.update();

    switch (this.state) {
      case GameState.Title:
        this.updateTitle(dt);
        break;
      case GameState.Playing:
        this.updatePlaying(dt);
        break;
      case GameState.GameOver:
        this.updateGameOver(dt);
        break;
    }

    // Trail disc update removed - particles updated via particle system

    this.topDownShadow.update(this.player.mesh.position);
    this.topDownShadow.render();
    this.composer.render();
    if (!this.hasRenderedFirstFrame) {
      this.hasRenderedFirstFrame = true;
      signalFirstFrame();
    }
    this.input.endFrame();
  }

  private updateTitle(dt: number) {
    const t = performance.now() * 0.0003;
    this.camera.position.set(Math.sin(t) * 8.6, 6.2 + Math.sin(t * 2) * 0.25, Math.cos(t) * 8.6 + 1.2);
    this.camera.lookAt(0, 4.2, 0);
    const idleBob = Math.sin(performance.now() * 0.002) * 0.06;
    this.player.mesh.position.y = 0.32 + idleBob;

    this.updateWorld(dt);
    this.updatePlayerLight(dt);

    if (this.multiplayer.isActive()) {
      // Keep the lobby responsive: drain messages + refresh the panel each
      // frame while idling on the title screen. Don't broadcast — we're not
      // playing, so sending (0,0,0) would show stale ghosts to peers.
      this.multiplayer.pollPeers(dt);
      this.refreshMultiplayerPanel();
    }

    // Keyboard restart from title. Click-to-start on empty title is handled by
    // the titleOverlay click listener, which correctly ignores clicks that
    // land on a button (ACHIEVEMENTS, MULTIPLAYER, AI GHOST, RACE THE AI).
    if (this.input.justPressed("space")) {
      this.startGame();
    }
  }

  private startGame() {
    const wasGameOver = this.state === GameState.GameOver;
    if (this.isChallengeMode) {
      // Lock the tower layout to the picked ghost's seed so the player sees
      // exactly the same gear layout the ghost was recorded on. Falls back to
      // CHALLENGE_SEED for the on-disk local ghost (which was always recorded
      // on that seed). Daily mode wins if both are set — startDailyChallenge
      // runs first and would disable challenge mode.
      this.isDailyChallenge = false;
      this.sim.setSeed(this.ghostChallengeRecord?.seed ?? CHALLENGE_SEED);
    } else if (!this.isDailyChallenge) {
      this.dailyChallengeDate = utcDateKey();
      this.dailyPreviousBest = null;
      const mpSeed = this.multiplayer.isActive() ? this.multiplayer.getSyncedSeed() : null;
      this.sim.setSeed(mpSeed ?? this.regularSeed);
    }
    initAudio();
    playClick();
    this.resumeAnimationLoop();
    if (wasGameOver) {
      // Dismissing the game-over overlay — flush any queued unlocks.
      this.flushAchievementUnlockQueue();
    }
    this.state = GameState.Playing;
    this.runStartElapsedTime = this.elapsedTime;
    this.toastTimer = 0;
    this.zoneAnnouncementTimer = 0;
    this.lastAnnouncedZone = -1;
    this.cameraKick = 0;
    this.cameraShakeTimer = 0;
    this.cameraShakeOffset.set(0, 0, 0);
    this.cameraDistancePulses.length = 0;
    this.comboFovPulseTimer = 0;
    this.lastComboMultiplier = 1;
    this.lastDoubleJumpCharges = 0;
    this.lastShieldCount = 0;
    this.closeCallFlashTimer = 0;
    this.nearMissSlowTimer = 0;
    this.steamSpawnTimer = 0;
    this.deathAnimTimer = 0;
    this.challengeZoneBloomBoost = 0;
    this.seenWindGear = false;
    this.seenMagnetGear = false;
    this.seenGearFreeze = false;
    this.windParticleTimer = 0;
    this.magnetParticleTimer = 0;
    this.gearFreezeParticleTimer = 0;
    this.trailWispTimer = 0;
    this.gearFreezeActive = false;
    this.personalBestReachedThisRun = false;
    this.inChallengeZone = false;
    this.closeCallOverlay.style.opacity = "0";
    this.titleOverlay.style.overflowY = "";
    this.player.reset(0, 2);
    this.player.resetVisuals();
    this.resetVisualWorld();

    // Commit Run Contracts before the first consumeState so the bonus starts
    // at zero. Daily runs intentionally skip contracts — they already have a
    // fixed daily objective.
    this.resetContractRunCounters();
    this.commitContractsForRun();
    // Preview panel is a title-screen-only affordance; hide it during play.
    this.contractsPreviewPanel.classList.add("hidden");

    const { state, events } = this.sim.reset();
    this.consumeState(state);
    this.syncVisuals(state);
    this.buildBackgroundAtmosphere(this.getMaxGearHeight(state) + 24);
    this.handleEvents(events, state);
    this.updateHud(dtZero());

    this.hud.classList.remove("hidden");
    this.titleOverlay.classList.add("hidden");
    this.titleOverlay.classList.remove("game-over");
    this.pauseOverlay.classList.add("hidden");
    this.gameOverView.classList.add("hidden");
    this.titleLeaderboardPanel.classList.remove("hidden");
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.titleTagline.classList.remove("new-best");
    this.titleBest.classList.add("hidden");
    this.zoneAnnouncement.style.opacity = "0";
    this.zoneAnnouncement.style.transform = "translate(-50%, 12px)";
    this.input.setTouchControlsVisible(this.input.isTouchDevice());
    this.showTutorialOverlay();
    startAmbientTick();
    startMusic();
    this.hideLandingCueHard();
    // Trail sampling removed - particles spawn on jump/landing events

    if (this.personalBestRing) {
      this.personalBestRing.position.set(0, this.personalBestHeight, 0);
      this.personalBestRing.visible = this.personalBestHeight > 0;
      (this.personalBestRing.material as THREE.MeshBasicMaterial).opacity = 0.3;
    }

    this.hideMultiplayerPanel();
    this.hideEndScreen();
    if (this.multiplayerButton) {
      this.multiplayerButton.style.display = "none";
    }
    if (this.aiGhostButton) {
      this.aiGhostButton.style.display = "none";
    }
    this.clearGhostMeshes();
    this.resetAIGhost();
    this.startGhostSession();
  }

  /**
   * Start the ghost recorder on every run and, when in challenge mode, also
   * start playback of the fetched remote ghost. Called from startGame after
   * the sim has reset.
   */
  private startGhostSession(): void {
    // Clean up any prior playback from the previous run.
    if (this.ghostPlayback) {
      this.ghostPlayback.dispose();
      this.ghostPlayback = null;
    }
    this.ghostRecorder.stop();

    // Always record — submission is gated on the score threshold in finishGhostSession.
    this.ghostRecorder.start();

    // Challenge mode: also play back the fetched ghost so the player races it.
    if (this.isChallengeMode && this.ghostChallengeRecord) {
      this.ghostPlayback = new GhostPlayback(this.scene, this.ghostChallengeRecord);
      this.ghostPlayback.start();
    }
  }

  private pauseGame() {
    this.state = GameState.Paused;
    this.pauseOverlay.classList.remove("hidden");
    this.pauseAnimationLoop();
    stopMusic();
    stopAmbientTick();
  }

  private resumeGame() {
    this.state = GameState.Playing;
    this.pauseOverlay.classList.add("hidden");
    this.resumeAnimationLoop();
    startMusic();
    startAmbientTick();
  }

  private updatePlaying(dt: number) {
    if (this.nearMissSlowTimer > 0) {
      this.nearMissSlowTimer = Math.max(0, this.nearMissSlowTimer - dt);
      dt *= 0.7;
    }

    // Countdown overlay update — runs before input so the display is current
    // this frame. Only polls when countdownActive to avoid per-frame overhead.
    if (this.countdownActive) {
      this.updateCountdownOverlay();
    }

    // Gate all player input during the pre-match countdown.
    const blocked = this.countdownActive;
    const action: SimAction = {
      moveX: blocked ? 0 : this.input.getMovement().x,
      moveY: blocked ? 0 : this.input.getMovement().y,
      jump: blocked ? false : this.input.justPressed("space"),
    };

    const { state, events } = this.sim.step(action, dt);
    this.consumeState(state);
    this.handleEvents(events, state);

    // ── Multiplayer finish detection (100 m crossing) ──────────────────────────
    if (
      this.multiplayer.isActive() &&
      this.multiplayer.getMatchState() === "in_match" &&
      !this.localFinished &&
      this.heightMaxReached >= 100
    ) {
      this.localFinished = true;
      const elapsedMs = Date.now() - this.multiplayer.getLocalStartAt();
      this.multiplayer.notifyFinished(elapsedMs, this.score, this.heightMaxReached);
    }

    // ── Match timer HUD update ─────────────────────────────────────────────────
    if (this.multiplayer.isActive() && this.multiplayer.getMatchState() === "in_match") {
      this.updateMatchTimerOverlay();
    }

    this.updateContracts(dt);
    this.updatePlayerVisuals(dt, state.player, state.orbitAngle);
    this.syncVisuals(state);
    this.updateBouncyGearSquashes(dt);
    setTickRate(this.heightMaxReached);
    setMusicIntensity(this.heightMaxReached);
    this.challengeZoneBloomBoost = Math.max(0, this.challengeZoneBloomBoost - dt * 0.7);
    this.updateEnvironment(state.player.y);
    this.updateWorld(dt);
    this.updateCamera(dt, state);
    this.updateLandingCue(state, dt);
    this.updateAirborneTrail(dt, state);
    this.updatePersonalBestRing(state.player.y);
    this.updateHud(dt);
    this.tickMultiplayer(dt, state);
    this.updateAIGhost(dt);
    this.updateGhostSession(dt, state);

    // Check personal best
    if (
      this.personalBestHeight > 0 &&
      !this.personalBestReachedThisRun &&
      state.player.y > this.personalBestHeight
    ) {
      this.personalBestReachedThisRun = true;
      this.showToast("NEW PERSONAL BEST!");
      this.landingEffectPosition.set(state.player.x, state.player.y, state.player.z);
      this.particles.spawnMilestoneConfetti(this.landingEffectPosition);
    }

    if (state.gameState === "gameover") {
      this.finishGame(state);
    }
  }

  private updatePersonalBestRing(playerY: number) {
    if (!this.personalBestRing || this.personalBestHeight <= 0) return;
    const dist = Math.abs(playerY - this.personalBestHeight);
    const shouldBeVisible = dist < 50;
    this.personalBestRing.visible = shouldBeVisible;
    if (shouldBeVisible) {
      const pulse = 0.3 + Math.sin(this.elapsedTime * 1.8) * 0.08;
      (this.personalBestRing.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
  }

  private tickMultiplayer(dt: number, state: SimState) {
    // edge: solo gameplay — all multiplayer paths are gated here; no MP calls
    // execute in solo mode.
    if (!this.multiplayer.isActive()) return;
    this.multiplayer.update(
      dt,
      state.player.x,
      state.player.y,
      state.player.z,
      this.heightMaxReached,
      this.score,
      this.bestCombo,
      state.player.onGround
    );
    this.updateGhosts(dt);
  }

  private finishGame(state: SimState) {
    this.state = GameState.GameOver;
    // Notify peers of local death before any other state changes.
    if (this.multiplayer.isActive()) {
      this.multiplayer.notifyDied(this.score, this.heightMaxReached);
    }
    this.input.setTouchControlsVisible(false);
    this.hideTutorialOverlay(true);
    this.hideLandingCueHard();
    this.finishGhostSession();
    // Fresh queue for this run's unlocks — any pending from a prior run
    // should have been flushed already on dismiss, but guard just in case.
    this.achievementUnlockQueue.length = 0;
    this.renderGameOverUnlocks();
    // Trail sampling removed
    if (this.personalBestRing) {
      this.personalBestRing.visible = false;
    }
    // Update personal best height in localStorage
    if (this.heightMaxReached > this.personalBestHeight) {
      this.personalBestHeight = this.heightMaxReached;
      localStorage.setItem("clockwork-personal-best-height", String(this.heightMaxReached));
    }
    // Restore gear emissives if freeze was still active at death
    if (this.gearFreezeActive) {
      this.gearFreezeActive = false;
      for (const gear of this.visualGearMap.values()) {
        gear.setFreezeEmissive(false);
      }
    }
    this.player.setDoubleJumpCharges(0);
    this.player.setShieldCount(0);
    stopAmbientTick();
    stopMusic();
    this.deathAnimTimer = 0.4;
    this.toastTimer = 0;
    this.hudToast.style.opacity = "0";
    this.hudToast.style.transform = "translate(-50%, 12px)";
    this.closeCallFlashTimer = 0;
    this.shieldSaveFlashTimer = 0;
    this.shieldSaveOverlay.style.opacity = "0";
    this.closeCallOverlay.style.opacity = "0";

    if (this.isDailyChallenge) {
      this.dailyChallengeDate = utcDateKey();
      this.dailyPreviousBest = this.readDailyBest(this.dailyChallengeDate);
    }

    const runPlaytime = Math.max(0, this.elapsedTime - this.runStartElapsedTime);
    const isNewBest = this.score > this.saveData.bestScore;
    const nextSaveData: SaveData = {
      bestScore: Math.max(this.saveData.bestScore, this.score),
      bestHeight: Math.max(this.saveData.bestHeight, this.heightMaxReached),
      bestCombo: Math.max(this.saveData.bestCombo, this.bestCombo),
      totalRuns: this.saveData.totalRuns + 1,
      totalBolts: this.saveData.totalBolts + this.boltCount,
      totalPlaytime: this.saveData.totalPlaytime + runPlaytime,
      audioEnabled: getAudioEnabled(),
    };
    this.saveData = nextSaveData;
    this.highScore = nextSaveData.bestScore;

    updateStat("total_score", getStat("total_score") + this.score);
    updateStat("total_bolts", getStat("total_bolts") + this.boltCount);
    updateStat("total_runs", getStat("total_runs") + 1);
    updateStat("best_combo", Math.max(getStat("best_combo"), this.bestCombo));
    updateStat("highest_climb", Math.max(getStat("highest_climb"), this.heightMaxReached));
    updateStat("total_playtime", getStat("total_playtime") + runPlaytime);
    storeStats();

    void writeSaveData(JSON.stringify(nextSaveData)).catch((error: unknown) => {
      console.error("Failed to save run data", error);
    });
    void submitScores(
      {
        score: this.score,
        height: this.heightMaxReached,
        combo: this.bestCombo,
      },
      this.getLocalUsername(),
    ).catch((error: unknown) => {
      console.error("Failed to submit score", error);
    });
    if (this.isDailyChallenge) {
      this.writeDailyBest(this.dailyChallengeDate, this.score);
      void submitDailyScore(this.score, this.getLocalUsername()).catch((error: unknown) => {
        console.error("Failed to submit daily score", error);
      });
    }
    void this.refreshLeaderboardPanels(this.isDailyChallenge ? "daily-score" : "high-score").catch((error: unknown) => {
      console.error("Failed to refresh leaderboard panels", error);
    });

    // Unlock and toast *newly earned* achievements this run
    const newAchievements: string[] = [];
    if (this.score > 0 && unlockAchievement("FIRST_CLIMB")) newAchievements.push("FIRST_CLIMB");
    if (this.score >= 500 && unlockAchievement("RISING_STAR")) newAchievements.push("RISING_STAR");
    if (this.score >= 2000 && unlockAchievement("GEAR_MASTER")) newAchievements.push("GEAR_MASTER");
    if (this.saveData.totalRuns === 1 && this.score >= 500 && unlockAchievement("PERFECT_START")) newAchievements.push("PERFECT_START");
    if (state.bestAirBoltChain >= 3 && unlockAchievement("BOLT_CHAIN")) newAchievements.push("BOLT_CHAIN");
    newAchievements.forEach((id, index) => {
      setTimeout(() => {
        if (this.state === GameState.GameOver) {
          this.showAchievementToast(formatAchievementId(id));
        }
      }, index * 2300);
    });

    this.updateHud(dtZero());
    this.comboGlowOverlay.style.opacity = "0";
    this.clearScorePops();
    this.cameraDistancePulses.length = 0;
    this.comboFovPulseTimer = 0;

    if (this.multiplayer.isActive()) {
      // In multiplayer: suppress solo game-over UI. The end screen will appear
      // via onMatchEnded when the match resolver fires.
      // NOTE: Do NOT hide matchTimerOverlay here — other players are still racing.
      // The timer continues to show from updateGameOver() until onMatchEnded fires.
      this.hideCountdown();
      return;
    }

    // ── Solo game-over UI (unchanged) ─────────────────────────────────────────
    this.titleOverlay.classList.remove("hidden");
    this.titleOverlay.classList.add("game-over");
    this.titleOverlay.style.overflowY = "auto";
    this.titleBest.classList.add("hidden");
    this.shareScoreBtn.classList.remove("hidden");
    this.titleLeaderboardPanel.classList.add("hidden");
    this.buildTitleBackdrop();
    this.titleHeading.textContent = "GAME OVER";
    Object.assign(this.titleHeading.style, {
      background: "",
      backgroundClip: "",
      webkitBackgroundClip: "",
      webkitTextFillColor: "",
      textShadow: "",
    });
    if (isNewBest) {
      this.titleTagline.textContent = `★ NEW BEST ★  SCORE ${this.score} · HEIGHT ${this.heightMaxReached}m`;
      this.titleTagline.classList.add("new-best");
    } else {
      this.titleTagline.textContent = `SCORE ${this.score} · HEIGHT ${this.heightMaxReached}m · BEST ${this.highScore}`;
      this.titleTagline.classList.remove("new-best");
    }
    if (this.isDailyChallenge) {
      this.titleTagline.textContent = `DAILY CHALLENGE · ${formatHumanDate(this.dailyChallengeDate)} · SCORE ${this.score} · HEIGHT ${this.heightMaxReached}m`;
      this.titleTagline.classList.remove("new-best");
    }
    this.titlePrompt.textContent = "RESTART";
    this.titleActions.classList.add("hidden");
    this.refreshUsernameUi();

    const gameSeconds = Math.floor(state.gameTime);
    this.gameOverHeightEl.textContent = String(this.heightScore);
    this.gameOverBoltsEl.textContent = String(this.boltScore);
    this.gameOverBoltCountEl.textContent = String(this.boltCount);
    this.gameOverComboEl.textContent = `x${this.bestCombo}`;
    this.gameOverTimeEl.textContent = `${gameSeconds}s`;
    this.gameOverTotalEl.textContent = String(this.score);

    const contractsRow = document.getElementById("go-contracts-row");
    const contractsValue = document.getElementById("go-contracts");
    if (contractsRow && contractsValue) {
      if (this.contractBonus > 0 && !this.isDailyChallenge) {
        const completed = this.activeContracts.filter((c) => c.complete).length;
        contractsValue.textContent = `+${this.contractBonus} · ${completed}/${this.activeContracts.length}`;
        contractsRow.classList.remove("hidden");
      } else {
        contractsRow.classList.add("hidden");
      }
    }

    this.renderGameOverContracts();

    // Pre-roll contracts for the next run but keep the preview panel hidden —
    // it's a title-screen affordance; the player will see it after clicking
    // PLAY AGAIN or TITLE SCREEN.
    this.contractsHudPanel.classList.add("empty");
    this.rerollPreviewContracts();
    this.renderContractsPreview();
    this.contractsPreviewPanel.classList.add("hidden");
    this.renderLeaderboardList(
      this.gameOverLeaderboardContext,
      this.gameOverLeaderboardList,
      this.gameOverLeaderboardEntries,
      this.isDailyChallenge
        ? `DAILY CHALLENGE · ${formatHumanDate(this.dailyChallengeDate)} · THIS RUN ${this.score}`
        : `THIS RUN ${this.score} · BEST ${this.saveData.bestScore}`
    );
    this.gameOverLeaderboardThreshold.textContent = this.getGameOverCallout();
    this.gameOverView.classList.remove("hidden");
    this.gameOverLeaderboardPanel.classList.remove("hidden");

    if (this.multiplayer.isAvailable()) {
      if (this.multiplayerButton) {
        this.multiplayerButton.style.display = "inline-flex";
      }
    }
    if (this.aiGhostButton) {
      this.aiGhostButton.style.display = "inline-flex";
    }
  }

  private renderMultiplayerGameOverBoard() {
    const localUsername = this.getLocalUsername();
    const combined: LeaderboardDisplayEntry[] = [
      { username: localUsername, score: this.score, rank: 0 },
      ...this.multiplayer.getPeers().map((peer) => ({
        username: peer.username,
        score: peer.score,
        rank: 0,
      })),
    ];
    combined.sort((a, b) => b.score - a.score);
    const ranked = combined.map((entry, index) => ({ ...entry, rank: index + 1 }));
    this.renderLeaderboardList(
      this.gameOverLeaderboardContext,
      this.gameOverLeaderboardList,
      ranked,
      `MULTIPLAYER RACE · ${ranked.length} PLAYER${ranked.length === 1 ? "" : "S"}`
    );
  }

  private getLocalUsername(): string {
    try {
      const wavedashName = getUsername();
      // Only use the wavedash name if it's a real user-set value — not the SDK
      // default ("Player"). Fall through to our persisted coolname otherwise.
      if (wavedashName && wavedashName !== "Player") {
        return wavedashName;
      }
    } catch { /* SDK may not be available */ }
    return getCoolLocalUsername();
  }

  private readDailyBest(dateKey: string): number | null {
    try {
      const raw = localStorage.getItem(dailyBestStorageKey(dateKey));
      if (!raw) {
        return null;
      }
      const score = parseInt(raw, 10);
      return Number.isFinite(score) ? score : null;
    } catch {
      return null;
    }
  }

  private writeDailyBest(dateKey: string, score: number): void {
    if (!Number.isFinite(score) || score <= 0) {
      return;
    }

    const currentBest = this.readDailyBest(dateKey);
    if (currentBest !== null && currentBest >= score) {
      return;
    }

    try {
      localStorage.setItem(dailyBestStorageKey(dateKey), String(Math.floor(score)));
    } catch {
      // Ignore storage failures.
    }
  }

  private updateGameOver(dt: number) {
    this.updateWorld(dt);
    this.updatePlayerLight(dt);
    if (this.isDailyChallenge) {
      this.gameOverLeaderboardThreshold.textContent = this.getGameOverCallout();
    }

    if (this.deathAnimTimer > 0) {
      this.deathAnimTimer -= dt;
      this.player.setBodyOpacity(Math.max(0, this.deathAnimTimer / 0.4));
    }

    if (this.multiplayer.isActive()) {
      // Keep peers fresh on the post-run lobby screen — no broadcast.
      this.multiplayer.pollPeers(dt);
      this.refreshMultiplayerPanel();
      // Match timer keeps ticking even after local player dies — others are still racing.
      if (this.multiplayer.getMatchState() === "in_match") {
        this.updateMatchTimerOverlay();
      }
    }

    // Keyboard-only restart. Mouse clicks on the game-over overlay are routed
    // through the title-overlay click handler (which respects button targets),
    // so we don't blanket-consume global clicks here — that would collapse
    // every button click into "start game".
    if (this.input.justPressed("space")) {
      this.startGame();
    }
  }

  private consumeState(state: SimState) {
    this.simState = state;
    const simScoreDelta = state.score - this.lastSimScore;
    this.lastSimScore = state.score;
    // Fold the Run Contracts bonus into the displayed score so the main
    // scoreboard and the post-run share/leaderboard pipeline pick it up
    // for free.
    this.score = state.score + this.contractBonus;
    this.heightScore = state.heightScore;
    this.heightMaxReached = state.heightMaxReached;
    this.boltCount = state.boltCount;
    this.boltScore = state.boltScore;
    this.gameTime = state.gameTime;
    this.nextMilestone = state.nextMilestone;
    this.currentZoneIndex = state.currentZoneIndex;
    this.bestCombo = state.bestCombo;
    this.inChallengeZone = state.inChallengeZone;

    if (simScoreDelta > 0) {
      this.spawnScorePop(simScoreDelta);
    }
  }

  private syncVisuals(state: SimState) {
    const nextGearIds = new Set(state.gears.map((gear) => gear.id));
    for (const [id, gear] of this.visualGearMap) {
      if (nextGearIds.has(id)) {
        continue;
      }
      // Release to pool (removes mesh from scene; keeps instance for future reuse).
      this.gearPool.release(gear);
      this.visualGearMap.delete(id);
      this.gearTickNextTimes.delete(id);
      this.bouncyGearSquashTimers.delete(id);
      this.crumbleSfxArmed.delete(id);
      this.crumbleSfxFalling.delete(id);
      this.windGustNextTimes.delete(id);
      this.magnetPulseNextTimes.delete(id);
    }

    for (const simGear of state.gears) {
      let gear = this.visualGearMap.get(simGear.id);
      if (!gear) {
        // createGearVisual now calls gearPool.acquire(), which adds the mesh to the scene.
        gear = this.createGearVisual(simGear);
        this.visualGearMap.set(simGear.id, gear);
        if (this.gearFreezeActive) {
          gear.setFreezeEmissive(true);
        }
      }
      this.applySimGearToVisual(gear, simGear, state.elapsedTime);
    }
    this.gears = state.gears.map((gear) => this.visualGearMap.get(gear.id)).filter((gear): gear is Gear => gear !== undefined);

    const nextBoltIds = new Set(state.bolts.map((bolt) => bolt.id));
    for (const [id, bolt] of this.visualBoltMap) {
      if (nextBoltIds.has(id)) {
        continue;
      }
      this.scene.remove(bolt.mesh);
      this.visualBoltMap.delete(id);
    }
    for (const simBolt of state.bolts) {
      let bolt = this.visualBoltMap.get(simBolt.id);
      if (!bolt) {
        const gear = this.visualGearMap.get(simBolt.gearId);
        if (!gear) {
          continue;
        }
        bolt = new BoltCollectible(gear);
        bolt.reset();
        this.visualBoltMap.set(simBolt.id, bolt);
        this.scene.add(bolt.mesh);
      }
      this.applySimBoltToVisual(bolt, simBolt);
    }
    this.bolts = state.bolts.map((bolt) => this.visualBoltMap.get(bolt.id)).filter((bolt): bolt is BoltCollectible => bolt !== undefined);

    // Sync power-up visuals
    const nextPowerUpIds = new Set(state.powerUps.map((p) => p.id));
    for (const [id, mesh] of this.visualPowerUpMap) {
      if (nextPowerUpIds.has(id)) {
        continue;
      }
      this.scene.remove(mesh);
      this.visualPowerUpMap.delete(id);
    }
    for (const simPowerUp of state.powerUps) {
      let mesh = this.visualPowerUpMap.get(simPowerUp.id);
      if (!mesh) {
        mesh = createPowerUpMesh(simPowerUp.type);
        this.visualPowerUpMap.set(simPowerUp.id, mesh);
        this.scene.add(mesh);
      }
      mesh.visible = simPowerUp.available;
      mesh.position.set(simPowerUp.x, simPowerUp.y, simPowerUp.z);
    }

    this.player.mesh.position.set(state.player.x, state.player.y, state.player.z);
    this.ensureBackgroundCoverage(state);
  }

  private createGearVisual(simGear: SimGear): Gear {
    const palette = [0x8c6239, 0xb87333, 0xa67c52, 0x7c5a2c];
    const variantBaseColors: Partial<Record<GearVariant, number>> = {
      wind: 0x4488aa,
      magnetic: 0x8844aa,
      bouncy: 0x44aa44,
      milestone: 0xdaa520, // Golden
    };
    const baseColor = variantBaseColors[simGear.variant as GearVariant] ?? palette[simGear.id % palette.length];
    const band = getDifficultyBand(simGear.y);
    // Acquire from pool (adds mesh to scene; reuses a free entry if one exists in the
    // same variant × tooth-count bucket, otherwise constructs a new Gear instance).
    const gear = this.gearPool.acquire({
      color: baseColor,
      danger: band.danger,
      height: simGear.height,
      radius: simGear.radius,
      rotationSpeed: simGear.rotationSpeed,
      variant: simGear.variant as GearVariant,
    });
    // enableTopDownShadow is idempotent — no-op if already patched on a reused gear.
    gear.enableTopDownShadow(this.topDownShadow.uniforms);
    gear.rotationDir = simGear.rotationDir;
    return gear;
  }

  private applySimGearToVisual(gear: Gear, simGear: SimGear, simElapsed: number) {
    gear.rotationDir = simGear.rotationDir;
    setPrivate(gear, "active", simGear.active);
    setPrivate(gear, "crumbleArmed", simGear.crumbleArmed);
    setPrivate(gear, "crumbleTimer", simGear.crumbleTimer);
    setPrivate(gear, "crumbleFallVelocity", simGear.crumbleFallVelocity);
    setPrivate(gear, "crumbleFallDistance", simGear.crumbleFallDistance);
    setPrivate(gear, "reverseTimer", simGear.reverseTimer);
    setPrivate(gear, "reverseInterval", simGear.reverseInterval);
    setPrivate(gear, "reversePause", simGear.reversePause);
    setPrivate(gear, "pistonTime", simGear.pistonTime);
    gear.mesh.position.set(simGear.x, getRenderedGearY(simGear), simGear.z);
    gear.mesh.rotation.y = simGear.currentRotation;
    gear.syncCrumbleVisuals(simGear.crumbleArmed, simGear.crumbleTimer, simGear.crumbleFallDistance);

    // Crumble SFX: detect arm → fall transitions and fire sounds
    if (simGear.variant === "crumbling" && this.state === GameState.Playing) {
      const wasArmed = this.crumbleSfxArmed.get(simGear.id) ?? false;
      const wasFalling = this.crumbleSfxFalling.get(simGear.id) ?? false;
      const isArmed = simGear.crumbleArmed;
      const isFalling = simGear.crumbleFallVelocity > 0;
      if (isArmed && !wasArmed) {
        playCrumbleGearCrack("arm");
      }
      if (isFalling && !wasFalling) {
        playCrumbleGearCrack("fall");
      }
      this.crumbleSfxArmed.set(simGear.id, isArmed);
      this.crumbleSfxFalling.set(simGear.id, isFalling);
    }

    // Spawn fade: gears born during play fade in over 0.45s (smoothstep).
    // Boot gears have spawnTime = -Infinity → age = Infinity → fade = 1 (no effect).
    const SPAWN_FADE_DURATION = 0.45;
    const age = simElapsed - simGear.spawnTime;
    const t = THREE.MathUtils.clamp(age / SPAWN_FADE_DURATION, 0, 1);
    const spawnOpacity = t * t * (3 - 2 * t); // smoothstep
    gear.applySpawnFade(spawnOpacity);
  }

  private applySimBoltToVisual(bolt: BoltCollectible, simBolt: SimBolt) {
    if (!simBolt.available) {
      setPrivate(bolt, "available", false);
    }
  }

  private updatePlayerVisuals(dt: number, simPlayer: SimPlayer, orbitAngle: number) {
    this.player.mesh.position.set(simPlayer.x, simPlayer.y, simPlayer.z);
    this.player.velocity.set(simPlayer.vx, simPlayer.vy, simPlayer.vz);
    this.player.onGround = simPlayer.onGround;
    this.player.highestY = simPlayer.highestY;
    this.player.prevY = simPlayer.prevY;
    setPrivate(this.player, "speedBoostTimer", simPlayer.speedBoostTimer);
    setPrivate(this.player, "speedBoostStrength", simPlayer.speedBoostStrength);
    this.player.setDoubleJumpCharges(simPlayer.doubleJumpCharges);
    this.player.setShieldCount(simPlayer.shieldCount);
    this.player.update(dt, this.input, orbitAngle);
    this.player.mesh.position.set(simPlayer.x, simPlayer.y, simPlayer.z);
    this.player.velocity.set(simPlayer.vx, simPlayer.vy, simPlayer.vz);
    this.player.onGround = simPlayer.onGround;
    this.player.highestY = simPlayer.highestY;
    this.player.prevY = simPlayer.prevY;
  }

  private handleEvents(events: SimEvent[], state: SimState) {
    for (const event of events) {
      switch (event.type) {
        case "gear_land":
          this.landingEffectPosition.set(event.x, event.y + 0.04, event.z);
          this.particles.spawnLandingSparks(this.landingEffectPosition, event.variant, event.landingSpeed);
          this.player.land(event.landingSpeed);
          playLand(event.landingSpeed / 12);
          this.cameraKick = Math.min(this.cameraKick + event.landingSpeed * 0.015, 0.28);
          if (event.nearMiss) {
            this.triggerCloseCallFlash();
            this.nearMissSlowTimer = 0.12;
            this.contractNearMisses += 1;
          }
          this.triggerLandingShake(Math.min(Math.abs(event.landingSpeed) * 0.01, 0.15));
          if (event.variant === "bouncy") {
            this.triggerBouncyGearSquash(event.gearId);
          }
          if (event.variant === "wind" && !this.seenWindGear) {
            this.seenWindGear = true;
            // Delay the toast slightly so a combo_up in the same batch doesn't overwrite it
            window.setTimeout(() => this.showToast("WIND GEAR — you'll be pushed!"), 80);
          }
          if (event.variant === "magnetic" && !this.seenMagnetGear) {
            this.seenMagnetGear = true;
            window.setTimeout(() => this.showToast("MAGNET GEAR — pulls to center!"), 80);
          }
          break;
        case "bolt_collect": {
          const bolt = this.visualBoltMap.get(event.boltId);
          if (bolt) {
            setPrivate(bolt, "available", false);
            setPrivate(bolt, "collectTimer", 0);
          }
          playCollect(1 + event.totalBolts * 0.02);
          this.showToast(`BOLT +5 · ${event.totalBolts} COLLECTED`);
          break;
        }
        case "combo_up":
          this.showToast(`COMBO x${event.multiplier}!`);
          playComboLand(event.multiplier);
          this.comboFovPulseTimer = 0.3;
          this.landingEffectPosition.set(state.player.x, state.player.y, state.player.z);
          this.particles.spawnComboFireworks(this.landingEffectPosition, event.multiplier);
          break;
        case "combo_break":
          this.showToast("COMBO LOST");
          break;
        case "milestone":
          this.showToast(`CHECKPOINT ${event.height}m`);
          playMilestone(1 + event.height / 220);
          this.particles.spawnMilestoneConfetti(this.player.mesh.position);
          this.triggerMilestoneActivation(event.height);
          this.addCameraDistancePulse(2, 0.5, 1);
          this.pulseMilestoneToast();
          break;
        case "piston_launch":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          playPistonLaunch();
          this.showToast("PISTON LAUNCH!");
          this.addCameraDistancePulse(0.5, 0.08, 0.2);
          break;
        case "speed_boost":
          this.showToast("SURGE GEAR");
          break;
        case "death_start":
          if (this.simState) {
            this.particles.spawnDeathBurst(this.player.mesh.position);
          }
          this.player.setDyingVisual();
          this.cameraShakeOffset.set(
            randomRange(-0.08, 0.08),
            randomRange(-0.05, 0.05),
            randomRange(-0.08, 0.08)
          );
          this.cameraShakeTimer = this.cameraShakeDuration;
          playHit();
          break;
        case "death":
          break;
        case "jump":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          playJump();
          this.particles.spawnJumpSteam(this.landingEffectPosition);
          this.cameraKick = Math.max(this.cameraKick, 0.12);
          break;
        case "gear_block":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnGearBonkSparks(this.landingEffectPosition, event.impactSpeed);
          this.particles.spawnBrassLandingSparks(this.landingEffectPosition);
          this.player.bonk(event.impactSpeed);
          this.triggerLandingShake(Math.min(0.04 + event.impactSpeed * 0.006, 0.1));
          this.cameraKick = Math.max(this.cameraKick, Math.min(event.impactSpeed * 0.008, 0.12));
          playGearBonk(event.impactSpeed / 9);
          break;
        case "zone_change":
          if (this.state === GameState.Playing) {
            this.showZoneAnnouncement(this.zoneNames[event.zoneIndex] ?? "???");
          }
          break;
        case "achievement":
          this.showAchievementToast(formatAchievementId(event.id));
          unlockAchievement(event.id);
          break;
        case "bounce_jump":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSteam(this.landingEffectPosition);
          this.particles.spawnJumpSteam(this.landingEffectPosition);
          playJump(1.45);
          playBouncyGearBounce(1.0);
          this.cameraKick = Math.max(this.cameraKick, 0.18);
          this.player.bouncyLaunch();
          this.triggerBouncyGearSquash(event.gearId);
          break;
        case "double_jump":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSteam(this.landingEffectPosition);
          this.particles.spawnJumpSteam(this.landingEffectPosition);
          playJump(1.25);
          this.cameraKick = Math.max(this.cameraKick, 0.16);
          this.doubleJumpFlashTimer = 0.5;
          break;
        case "powerup_collect":
          this.contractPowerupsCollected += 1;
          if (event.powerUpType === "double_jump") {
            this.landingEffectPosition.set(event.x, event.y, event.z);
            this.particles.spawnJumpSteam(this.landingEffectPosition);
            this.particles.spawnJumpSparks(this.landingEffectPosition);
            this.showToast(`DOUBLE JUMP +3! (×${state.player.doubleJumpCharges} total)`);
          } else if (event.powerUpType === "shield") {
            this.showToast(`SHIELD +1! (${state.player.shieldCount} total)`);
            this.shieldFlashTimer = 0.5;
          } else if (event.powerUpType === "gear_freeze") {
            if (!this.seenGearFreeze) {
              this.seenGearFreeze = true;
              window.setTimeout(() => this.showToast("GEAR FREEZE — clocks stopped!"), 80);
            }
            this.showToast(getPowerUpDisplayName(event.powerUpType));
          } else {
            this.showToast(getPowerUpDisplayName(event.powerUpType));
          }
          playCollect(1.8);
          break;
        case "gear_freeze_start":
          this.gearFreezeActive = true;
          for (const gear of this.visualGearMap.values()) {
            gear.setFreezeEmissive(true);
          }
          break;
        case "gear_freeze_end":
          this.gearFreezeActive = false;
          for (const gear of this.visualGearMap.values()) {
            gear.setFreezeEmissive(false);
          }
          break;
        case "shield_save": {
          const remaining = event.shieldCountRemaining;
          // Reset the "survive N seconds without a shield break" contract.
          this.contractLastShieldSaveAt = this.elapsedTime;
          this.particles.spawnDeathBurst(this.player.mesh.position);
          this.cameraShakeOffset.set(
            randomRange(-0.2, 0.2),
            randomRange(-0.12, 0.12),
            randomRange(-0.2, 0.2)
          );
          this.cameraShakeTimer = this.cameraShakeDuration * 2;
          const toastMsg = remaining > 0
            ? `SHIELD SAVED YOU! (${remaining} remaining)`
            : "SHIELD SAVED YOU!";
          this.showToast(toastMsg);
          this.triggerShieldSaveFlash();
          this.triggerCloseCallFlash();
          // Emissive boost on player body for ~1s
          this.player.bodyMaterial.emissive.setHex(0xff8844);
          this.player.bodyMaterial.emissiveIntensity = 2.0;
          window.setTimeout(() => {
            this.player.bodyMaterial.emissive.setHex(0x000000);
            this.player.bodyMaterial.emissiveIntensity = 0;
          }, 1000);
          // Louder, higher-pitched collect sound layered with hit
          playCollect(2.4);
          playHit();
          break;
        }
        case "challenge_zone_enter":
          this.showZoneAnnouncement("⚙ CHALLENGE ZONE!");
          this.challengeZoneBloomBoost = 0.08;
          break;
        case "challenge_zone_exit":
          if (event.bonusScore > 0) {
            this.showToast(`ZONE BONUS +${event.bonusScore}`);
          }
          break;
      }
    }

    this.updateComboHud(state.comboMultiplier);
  }

  private updateWorld(dt: number) {
    if (this.simState) {
      for (const simGear of this.simState.gears) {
        const gear = this.visualGearMap.get(simGear.id);
        if (!gear) {
          continue;
        }
        const nearCamera = Math.abs(getRenderedGearTopY(simGear) - this.camera.position.y) < 18;
        if (nearCamera && simGear.active && Math.random() < dt * 0.45) {
          this.particles.spawnGearSpark(gear);
        }

        // Animate wind ring pulse on wind gears near the camera
        if (nearCamera && simGear.variant === "wind" && simGear.active) {
          gear.updateWindRings(this.elapsedTime);
        }
        if (nearCamera && simGear.variant === "magnetic" && simGear.active) {
          gear.updateMagnetIndicator(this.elapsedTime);
        }
        // Landing-indicator rim glow lerp — cheap per-frame tick.
        gear.updateLandingHighlight(dt);

        if (this.state === GameState.Playing && simGear.active) {
          const distance = gear.mesh.position.distanceTo(this.player.mesh.position);
          if (distance <= 15) {
            const angularSpeed = Math.abs(getSimGearAngularVelocity(simGear));
            if (angularSpeed < 0.05) {
              this.gearTickNextTimes.delete(simGear.id);
            } else {
              const teethInterval = (Math.PI * 2) / Math.max(angularSpeed * Math.max(6, Math.floor(gear.radius * 10)), 0.001);
              const interval = THREE.MathUtils.clamp(teethInterval, 0.25, 1.25);
              const nextTickAt = this.gearTickNextTimes.get(simGear.id) ?? this.elapsedTime + interval;
              if (this.elapsedTime >= nextTickAt) {
                playGearTick(distance, angularSpeed);
                this.gearTickNextTimes.set(simGear.id, this.elapsedTime + interval);
              } else if (!this.gearTickNextTimes.has(simGear.id)) {
                this.gearTickNextTimes.set(simGear.id, nextTickAt);
              }
            }

            // Wind gust SFX — once per wind-ring cycle (1.4 s) when nearby
            if (simGear.variant === "wind") {
              const nextGustAt = this.windGustNextTimes.get(simGear.id) ?? 0;
              if (this.elapsedTime >= nextGustAt) {
                playWindGust(distance);
                this.windGustNextTimes.set(simGear.id, this.elapsedTime + 1.4);
              }
            }

            // Magnet pulse SFX — once per magnet cycle (1.2 s) when nearby
            if (simGear.variant === "magnetic") {
              const nextPulseAt = this.magnetPulseNextTimes.get(simGear.id) ?? 0;
              if (this.elapsedTime >= nextPulseAt) {
                playMagnetPulse(distance);
                this.magnetPulseNextTimes.set(simGear.id, this.elapsedTime + 1.2);
              }
            }
          } else {
            this.gearTickNextTimes.delete(simGear.id);
            this.windGustNextTimes.delete(simGear.id);
            this.magnetPulseNextTimes.delete(simGear.id);
          }
        }
      }

      // Spawn directional wind particles when player stands on a wind gear
      if (this.state === GameState.Playing) {
        const activeGear = this.simState.gears.find((g) => g.id === this.simState!.activeGearId);
        if (activeGear?.variant === "wind" && this.simState.player.onGround) {
          this.windParticleTimer -= dt;
          if (this.windParticleTimer <= 0) {
            this.windParticleTimer = 0.09;
            const gearPos = new THREE.Vector3(activeGear.x, activeGear.y + activeGear.height / 2, activeGear.z);
            this.particles.spawnWindGust(gearPos, activeGear.radius, activeGear.windAngle);
          }
        } else {
          this.windParticleTimer = 0;
        }

        if (activeGear?.variant === "magnetic" && this.simState.player.onGround) {
          this.magnetParticleTimer -= dt;
          if (this.magnetParticleTimer <= 0) {
            this.magnetParticleTimer = 0.12;
            const gearPos = new THREE.Vector3(activeGear.x, activeGear.y + activeGear.height / 2, activeGear.z);
            this.particles.spawnMagnetPull(gearPos, activeGear.radius);
          }
        } else {
          this.magnetParticleTimer = 0;
        }

        // Spawn ice crystal particles on nearby gears during gear freeze
        if (this.gearFreezeActive) {
          this.gearFreezeParticleTimer -= dt;
          if (this.gearFreezeParticleTimer <= 0) {
            this.gearFreezeParticleTimer = 0.14;
            for (const simGear of this.simState.gears) {
              if (!simGear.active) continue;
              const dx = simGear.x - this.simState.player.x;
              const dz = simGear.z - this.simState.player.z;
              if (dx * dx + dz * dz > 20 * 20) continue;
              if (Math.random() > 0.35) continue;
              const gearPos = new THREE.Vector3(simGear.x, simGear.y + simGear.height / 2, simGear.z);
              this.particles.spawnIceCrystals(gearPos, simGear.radius);
            }
          }
        } else {
          this.gearFreezeParticleTimer = 0;
        }
      }
    }

    for (const decoration of this.titleBackdropDecorations) {
      if (decoration.gear.variant === "wind") {
        decoration.gear.updateWindRings(this.elapsedTime);
      } else if (decoration.gear.variant === "magnetic") {
        decoration.gear.updateMagnetIndicator(this.elapsedTime);
      }
    }

    for (const bolt of this.bolts) {
      bolt.update(dt, this.elapsedTime);
    }

    // Animate power-up visuals
    if (this.simState) {
      for (const [id, mesh] of this.visualPowerUpMap) {
        if (!mesh.visible) continue;
        const simPowerUp = this.simState.powerUps.find((p) => p.id === id);
        if (simPowerUp) {
          mesh.position.set(
            simPowerUp.x,
            simPowerUp.y + Math.sin(this.elapsedTime * 3 + id * 0.7) * 0.12,
            simPowerUp.z
          );
        }
        mesh.rotation.y += dt * 2.5;
      }
    }

    for (const decoration of this.backgroundDecorations) {
      decoration.mesh.rotation.z += decoration.rotationSpeed * dt;
    }
    const titleTime = performance.now() * 0.001;
    for (const decoration of this.titleBackdropDecorations) {
      decoration.mesh.rotation.z += decoration.rotationSpeed * dt;
      decoration.mesh.position.y = decoration.baseY + Math.sin(titleTime + decoration.bobPhase) * decoration.bobAmplitude;
    }

    this.updateSteam(dt);
    this.particles.update(dt, this.player.mesh.position, this.camera);
    this.updateBiomeParticles(dt);
    this.updateSkydome(dt);
  }

  private updateCamera(dt: number, state: SimState) {
    const playerX = state.player.x;
    const playerY = state.player.y;
    const playerZ = state.player.z;
    const verticalLead = THREE.MathUtils.clamp(state.player.vy * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (state.player.onGround ? 5.5 : 4));
    const cameraPullback = this.updateCameraDistancePulses(dt);

    const radius = 12 + Math.max(-state.player.vy * 0.08, 0) + cameraPullback;
    const targetCamX = Math.cos(state.orbitAngle) * radius;
    const targetCamZ = Math.sin(state.orbitAngle) * radius;
    const targetCamY = playerY + 6.1 + verticalLead + this.cameraKick;

    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, targetCamX, followLerp);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, targetCamY, followLerp);
    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, targetCamZ, followLerp);

    // Right-rail HUD: on wide viewports the HUD claims the right ~22%, so we
    // aim the camera's look target to the right of the player. The camera
    // then frames the player in the left ~78% (the playable area) instead of
    // having the rail cover gameplay. Compute the offset in world units at
    // the player's depth by projecting the desired NDC offset back to world.
    let lookOffsetX = 0;
    let lookOffsetZ = 0;
    if (window.innerWidth >= 1280) {
      // Aim ~22% of the view width to the right of the player in screen
      // space. Convert to world units via fov + distance-to-player.
      const distToPlayer = Math.hypot(
        this.camera.position.x - playerX,
        this.camera.position.y - playerY,
        this.camera.position.z - playerZ
      );
      const halfViewWorld = Math.tan((this.camera.fov * Math.PI) / 360) * distToPlayer * this.camera.aspect;
      const shiftWorld = halfViewWorld * 0.22; // push target ~22% of half-width right
      // Camera "right" in world space. Three.js cameras use up=+Y and look
      // down their -Z axis, so for a forward = (dx, 0, dz) from camera to
      // player, camera-right = cross(forward, up) = (-dz, 0, dx) normalized.
      // (Previous version used (dz, -dx), which is the LEFT perpendicular —
      // that pushed the player off-screen to the RIGHT, under the HUD rail.)
      const dx = playerX - this.camera.position.x;
      const dz = playerZ - this.camera.position.z;
      const horizLen = Math.hypot(dx, dz) || 1;
      lookOffsetX = (-dz / horizLen) * shiftWorld;
      lookOffsetZ = (dx / horizLen) * shiftWorld;
    }

    this.cameraLookTarget.set(
      playerX + lookOffsetX,
      playerY + 1.3 + verticalLead * 0.35,
      playerZ + lookOffsetZ
    );
    this.camera.lookAt(this.cameraLookTarget);

    const comboFovPulse = this.comboFovPulseTimer > 0 ? (this.comboFovPulseTimer / 0.3) * 3 : 0;
    const targetFov = THREE.MathUtils.clamp(58 + Math.max(-state.player.vy - 5, 0) * 0.45 + comboFovPulse, 58, 67);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, followLerp);
    this.camera.updateProjectionMatrix();
    this.cameraKick = THREE.MathUtils.lerp(this.cameraKick, 0, 1 - Math.exp(-dt * 7));
    this.comboFovPulseTimer = Math.max(0, this.comboFovPulseTimer - dt);

    if (this.cameraShakeTimer > 0) {
      const shakeProgress = this.cameraShakeTimer / this.cameraShakeDuration;
      const shakeEnvelope = shakeProgress * shakeProgress;
      this.camera.position.addScaledVector(this.cameraShakeOffset, shakeEnvelope);
      this.cameraShakeTimer = Math.max(0, this.cameraShakeTimer - dt);
      if (this.cameraShakeTimer === 0) {
        this.cameraShakeOffset.set(0, 0, 0);
      }
    }

    this.updatePlayerLight(dt);
  }
  // Hard-reset helper: used at game-state transitions (title, gameover, respawn) where
  // we want to clear every piece of the landing indicator bundle without waiting for
  // the normal fade-out in updateLandingCue.
  private hideLandingCueHard() {
    this.landingCueGroup.visible = false;
    this.setHighlightedGear(null);
  }

  private updateLandingCue(state: SimState, dt: number) {
    const player = state.player;
    if (player.onGround) {
      this.landingCueGroup.visible = false;
      this.setHighlightedGear(null);
      return;
    }

    const landingSurface = this.findLandingSurface(state);
    if (!landingSurface) {
      // No landing target below (player over a gap). Project the cue a fixed distance
      // below the player's feet so there's always a visual "down" reference. Render only
      // the soft core at reduced opacity so it reads as "no target" vs. "target".
      // Scale from 0.6→1.2 based on distance below player (here ≈3m, map to mid scale).
      this.landingCueGroup.visible = true;
      this.landingCueGroup.position.set(player.x, player.y - 3.0, player.z);
      this.landingCueGroup.scale.setScalar(0.9);
      // Keep the 0.55 floor so the dot doesn't disappear on bright backgrounds.
      this.landingCueCoreMaterial.opacity = 0.55;
      this.landingCueRingMaterial.opacity = 0;
      this.landingCueGlowMaterial.opacity = 0;
      this.setHighlightedGear(null);
      return;
    }

    const dropHeight = Math.max(0, player.y - landingSurface.y);
    // Scaling landing shadow: 0.6× at 6m up → 1.2× at touchdown, smooth interp.
    const proximityT = 1 - THREE.MathUtils.clamp(dropHeight / 6, 0, 1);
    const shadowScale = THREE.MathUtils.lerp(0.6, 1.2, proximityT);

    // heightT: 0 = right above landing, 1 = far above (8m+ drop)
    const heightT = THREE.MathUtils.clamp(dropHeight / 8, 0, 1);

    // Core shadow dot: always visible when airborne. Opacity floor 0.55 so it doesn't
    // get lost on bright amber/gold gears; cap around 0.85 near touchdown.
    const coreOpacity = THREE.MathUtils.lerp(0.85, 0.55, heightT);

    // Ring: only visible when FAR from landing — fades in softly as you're still high
    // up, disappears completely near touchdown.
    const ringOpacity = THREE.MathUtils.clamp(heightT * 0.22, 0, 0.22);

    this.landingCueGroup.visible = true;
    this.landingCueGroup.position.set(player.x, landingSurface.y + 0.018, player.z);
    this.landingCueGroup.scale.setScalar(shadowScale);
    this.landingCueCoreMaterial.opacity = coreOpacity;
    this.landingCueRingMaterial.opacity = ringOpacity;
    this.landingCueGlowMaterial.opacity = 0;

    this.setHighlightedGear(landingSurface.gearId);
  }

  // --- Footstep trail removed — particles now spawn on jump/landing events ---
  // Old clearFootstepTrail, sampleFootstepTrail, and updateFootstepTrailDiscs methods removed

  private setHighlightedGear(gearId: number | null) {
    if (this.highlightedGearId === gearId) {
      return;
    }
    if (this.highlightedGearId !== null) {
      const prev = this.visualGearMap.get(this.highlightedGearId);
      if (prev) {
        prev.setLandingHighlight(false);
      }
    }
    if (gearId !== null) {
      const gear = this.visualGearMap.get(gearId);
      if (gear) {
        gear.setLandingHighlight(true);
      }
    }
    this.highlightedGearId = gearId;
  }

  private triggerBouncyGearSquash(gearId: number) {
    this.bouncyGearSquashTimers.set(gearId, 0);
  }

  private updateBouncyGearSquashes(dt: number) {
    if (this.bouncyGearSquashTimers.size === 0) {
      return;
    }

    // Three-phase bouncy squash — ~380ms total, reads as a clear "boing":
    //   phase 1 (0 → 80ms):   1.0 → {sy: 0.7, sxz: 1.12}  squash on contact (ease-out)
    //   phase 2 (80 → 260ms): squashed → {sy: 1.18, sxz: 0.94}  spring out with overshoot (ease-out-back)
    //   phase 3 (260 → 380ms): overshoot → 1.0  settle (ease-out)
    const PHASE1_END = 0.08;
    const PHASE2_END = 0.26;
    const PHASE3_END = 0.38;

    const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
    // ease-out-back approximation with ~15% overshoot
    const easeOutBack = (t: number) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };

    const toRemove: number[] = [];
    for (const [gearId, elapsed] of this.bouncyGearSquashTimers) {
      const next = elapsed + dt;
      const gear = this.visualGearMap.get(gearId);
      if (!gear) {
        toRemove.push(gearId);
        continue;
      }

      let sy: number;
      let sxz: number;
      if (next >= PHASE3_END) {
        sy = 1;
        sxz = 1;
        toRemove.push(gearId);
      } else if (next < PHASE1_END) {
        const t = easeOut(next / PHASE1_END);
        sy = 1 + (0.7 - 1) * t;
        sxz = 1 + (1.12 - 1) * t;
      } else if (next < PHASE2_END) {
        const t = easeOutBack((next - PHASE1_END) / (PHASE2_END - PHASE1_END));
        sy = 0.7 + (1.18 - 0.7) * t;
        sxz = 1.12 + (0.94 - 1.12) * t;
      } else {
        const t = easeOut((next - PHASE2_END) / (PHASE3_END - PHASE2_END));
        sy = 1.18 + (1 - 1.18) * t;
        sxz = 0.94 + (1 - 0.94) * t;
      }

      // Crumbling branch of syncCrumbleVisuals would fight this — bouncy gears are never
      // crumbling, so the non-crumble branch has already reset scale to 1 for us, and we
      // can apply our squash on top each frame.
      gear.mesh.scale.set(sxz, sy, sxz);

      this.bouncyGearSquashTimers.set(gearId, next);
    }
    for (const id of toRemove) {
      this.bouncyGearSquashTimers.delete(id);
    }
  }

  private findLandingSurface(state: SimState): { y: number; gearId: number } | null {
    const player = state.player;
    const playerRadius = 0.3;
    let bestY = -Infinity;
    let bestGearId = -1;

    for (const gear of state.gears) {
      if (!gear.active) {
        continue;
      }

      const dx = player.x - gear.x;
      const dz = player.z - gear.z;
      const reach = gear.radius + playerRadius + 0.02;
      if (dx * dx + dz * dz > reach * reach) {
        continue;
      }

      const topY = getRenderedGearTopY(gear);
      if (topY > player.y + 0.35 || topY <= bestY) {
        continue;
      }

      bestY = topY;
      bestGearId = gear.id;
    }

    return bestGearId >= 0 ? { y: bestY, gearId: bestGearId } : null;
  }
  private ensureBackgroundCoverage(state: SimState) {
    const maxHeight = this.getMaxGearHeight(state) + 24;
    if (this.backgroundGenerationHeight === 0) {
      this.backgroundGenerationHeight = maxHeight;
      return;
    }
    while (this.backgroundGenerationHeight < maxHeight) {
      this.backgroundGenerationHeight += 10;
      this.addBackgroundDecorationsAtHeight(this.backgroundGenerationHeight);
    }
  }

  private buildBackgroundAtmosphere(maxHeight: number) {
    const fogColor = new THREE.Color(0x2d2018);

    for (let index = 0; index < 14; index += 1) {
      const radius = randomRange(2.8, 6.4);
      const gear = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({
        color: fogColor.clone().offsetHSL(0.02, 0.06, randomRange(-0.08, 0.1)),
        emissive: 0x1b130f,
        emissiveIntensity: 0.35,
        metalness: 0.8,
        opacity: randomRange(0.12, 0.18),
        roughness: 0.45,
        transparent: true,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.18, 28), material);
      body.rotation.x = Math.PI / 2;
      gear.add(body);

      const toothMaterial = material.clone();
      toothMaterial.opacity *= 0.9;
      const toothGeo = new THREE.BoxGeometry(0.28, 0.18, 0.52);
      const toothCount = Math.floor(radius * 8);
      for (let toothIndex = 0; toothIndex < toothCount; toothIndex += 1) {
        const tooth = new THREE.Mesh(toothGeo, toothMaterial);
        const toothAngle = (toothIndex / toothCount) * Math.PI * 2;
        tooth.position.set(Math.cos(toothAngle) * radius, 0, Math.sin(toothAngle) * radius);
        tooth.rotation.y = -toothAngle;
        gear.add(tooth);
      }

      const orbitAngle = Math.random() * Math.PI * 2;
      const distance = randomRange(8.5, 16);
      gear.position.set(
        Math.cos(orbitAngle) * distance,
        randomRange(4, maxHeight),
        -7 - Math.sin(orbitAngle) * distance
      );
      this.backgroundGroup.add(gear);
      this.backgroundDecorations.push({
        mesh: gear,
        rotationSpeed: randomRange(0.04, 0.14) * (Math.random() > 0.5 ? 1 : -1),
      });
    }

    for (let index = 0; index < 9; index += 1) {
      const pipeMaterial = new THREE.MeshStandardMaterial({
        color: 0x4a372a,
        emissive: 0x130d09,
        emissiveIntensity: 0.2,
        metalness: 0.68,
        opacity: 0.16,
        roughness: 0.48,
        transparent: true,
      });
      const length = randomRange(4.5, 8.5);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, length, 10), pipeMaterial);
      const orbitAngle = Math.random() * Math.PI * 2;
      const distance = randomRange(6.2, 8.8);
      pipe.position.set(
        Math.cos(orbitAngle) * distance,
        randomRange(8, maxHeight),
        -6 - Math.sin(orbitAngle) * distance
      );
      pipe.rotation.z = Math.PI / 2 + randomRange(-0.4, 0.4);
      pipe.rotation.y = orbitAngle;
      this.backgroundGroup.add(pipe);
      this.backgroundDecorations.push({ mesh: pipe, rotationSpeed: 0 });
    }

    this.backgroundGenerationHeight = maxHeight;
  }

  private addBackgroundDecorationsAtHeight(baseHeight: number) {
    const fogColor = new THREE.Color(0x2d2018);

    const radius = randomRange(2.8, 6.4);
    const bgGear = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: fogColor.clone().offsetHSL(0.02, 0.06, randomRange(-0.08, 0.1)),
      emissive: 0x1b130f,
      emissiveIntensity: 0.35,
      metalness: 0.8,
      opacity: randomRange(0.12, 0.18),
      roughness: 0.45,
      transparent: true,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.18, 28), material);
    body.rotation.x = Math.PI / 2;
    bgGear.add(body);

    const toothMaterial = material.clone();
    toothMaterial.opacity *= 0.9;
    const toothGeo = new THREE.BoxGeometry(0.28, 0.18, 0.52);
    const toothCount = Math.floor(radius * 8);
    for (let index = 0; index < toothCount; index += 1) {
      const tooth = new THREE.Mesh(toothGeo, toothMaterial);
      const toothAngle = (index / toothCount) * Math.PI * 2;
      tooth.position.set(Math.cos(toothAngle) * radius, 0, Math.sin(toothAngle) * radius);
      tooth.rotation.y = -toothAngle;
      bgGear.add(tooth);
    }

    const orbitAngle = Math.random() * Math.PI * 2;
    const orbitDist = randomRange(8.5, 16);
    bgGear.position.set(
      Math.cos(orbitAngle) * orbitDist,
      randomRange(baseHeight - 8, baseHeight + 12),
      -7 - Math.sin(orbitAngle) * orbitDist
    );
    this.backgroundGroup.add(bgGear);
    this.backgroundDecorations.push({
      mesh: bgGear,
      rotationSpeed: randomRange(0.04, 0.14) * (Math.random() > 0.5 ? 1 : -1),
    });

    if (Math.random() < 0.5) {
      const pipeMaterial = new THREE.MeshStandardMaterial({
        color: 0x4a372a,
        emissive: 0x130d09,
        emissiveIntensity: 0.2,
        metalness: 0.68,
        opacity: 0.16,
        roughness: 0.48,
        transparent: true,
      });
      const length = randomRange(4.5, 8.5);
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, length, 10), pipeMaterial);
      const pipeAngle = Math.random() * Math.PI * 2;
      const pipeDist = randomRange(6.2, 8.8);
      pipe.position.set(
        Math.cos(pipeAngle) * pipeDist,
        randomRange(baseHeight - 5, baseHeight + 18),
        -6 - Math.sin(pipeAngle) * pipeDist
      );
      pipe.rotation.z = Math.PI / 2 + randomRange(-0.4, 0.4);
      pipe.rotation.y = pipeAngle;
      this.backgroundGroup.add(pipe);
      this.backgroundDecorations.push({ mesh: pipe, rotationSpeed: 0 });
    }
  }

  private updateOverlayText() {
    this.titleOverlay.classList.remove("game-over");
    this.titleOverlay.style.overflowY = "";
    this.titleLeaderboardPanel.classList.remove("hidden");
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.titleHeading.textContent = "CLOCKWORK CLIMB";
    Object.assign(this.titleHeading.style, {
      background: "linear-gradient(180deg, #cd853f 0%, #ffd700 50%, #cd853f 100%)",
      backgroundClip: "text",
      webkitBackgroundClip: "text",
      webkitTextFillColor: "transparent",
      textShadow: "0 2px 4px rgba(0,0,0,0.8), 0 0 40px rgba(255,170,68,0.3)",
    });
    this.titleTagline.textContent = "GAMEDEV.JS JAM 2026 — Theme: MACHINES";
    if (this.highScore > 0) {
      this.titleBest.textContent = `BEST SCORE ${this.highScore} · BEST HEIGHT ${this.saveData.bestHeight}m · BEST COMBO x${this.saveData.bestCombo}`;
      this.titleBest.classList.remove("hidden");
    } else {
      this.titleBest.textContent = "";
      this.titleBest.classList.add("hidden");
    }
    this.titlePrompt.textContent = "PLAY";
    this.titleActions.classList.remove("hidden");
    this.shareScoreBtn.classList.add("hidden");
    this.hudControls.textContent = this.input.isTouchDevice()
      ? "LEFT JOYSTICK TO MOVE · JUMP TO LEAP"
      : "WASD / ARROWS TO MOVE · SPACE OR TAP TO JUMP";
  }

  private showTutorialOverlay() {
    if (this.tutorialShown) {
      return;
    }

    this.tutorialShown = true;
    this.hideTutorialOverlay(true);
    this.tutorialControls.textContent = this.input.isTouchDevice()
      ? "JOYSTICK TO MOVE · JUMP BUTTON TO LEAP"
      : "WASD / ARROWS TO MOVE · SPACE TO JUMP";
    this.tutorialObjective.textContent = "LAND ON GEARS TO CLIMB HIGHER!";
    this.tutorialOverlay.classList.remove("hidden");
    this.tutorialOverlay.style.opacity = "1";
    const dismissTutorial = () => {
      this.removeTutorialDismissListeners();
      this.hideTutorialOverlay();
    };
    this.tutorialDismissHandler = dismissTutorial;
    for (const eventName of ["keydown", "pointerdown", "touchstart"]) {
      window.addEventListener(eventName, dismissTutorial, { once: true, passive: false });
    }
    this.tutorialFadeTimer = window.setTimeout(() => {
      this.removeTutorialDismissListeners();
      this.tutorialOverlay.style.opacity = "0";
      this.tutorialHideTimer = window.setTimeout(() => {
        this.tutorialOverlay.classList.add("hidden");
        this.tutorialHideTimer = null;
      }, 500);
      this.tutorialFadeTimer = null;
    }, 1800);
  }

  private hideTutorialOverlay(immediate = false) {
    this.removeTutorialDismissListeners();
    if (this.tutorialFadeTimer !== null) {
      clearTimeout(this.tutorialFadeTimer);
      this.tutorialFadeTimer = null;
    }
    if (this.tutorialHideTimer !== null) {
      clearTimeout(this.tutorialHideTimer);
      this.tutorialHideTimer = null;
    }

    if (immediate) {
      this.tutorialOverlay.style.opacity = "0";
      this.tutorialOverlay.classList.add("hidden");
      return;
    }

    this.tutorialOverlay.style.opacity = "0";
    this.tutorialHideTimer = window.setTimeout(() => {
      this.tutorialOverlay.classList.add("hidden");
      this.tutorialHideTimer = null;
    }, 500);
  }

  private removeTutorialDismissListeners() {
    if (!this.tutorialDismissHandler) {
      return;
    }
    for (const eventName of ["keydown", "pointerdown", "touchstart"]) {
      window.removeEventListener(eventName, this.tutorialDismissHandler);
    }
    this.tutorialDismissHandler = null;
  }

  private updateHud(dt: number) {
    this.hudScore.textContent = String(this.score);
    this.hudBest.textContent = `${Math.max(this.saveData.bestHeight, this.heightMaxReached)}m`;
    this.hudBolts.textContent = String(this.boltCount);

    const aiGs = this.aiGhostEnabled ? this.aiGhost?.getGhostState() : null;
    const aiHeightStr = aiGs ? ` · AI ${Math.round(aiGs.height)}m` : "";
    if (this.isChallengeMode && this.ghostPlayback) {
      this.hudStatus.textContent = `CHASING ${this.ghostPlayback.ghostName.toUpperCase()} (${this.ghostPlayback.ghostHeight}m) · YOU ${this.heightMaxReached}m · NEXT ${this.nextMilestone}m`;
    } else {
      this.hudStatus.textContent = this.isDailyChallenge
        ? `DAILY · ${formatHumanDate(this.dailyChallengeDate)} · SAME TOWER FOR EVERYONE · HEIGHT ${this.heightMaxReached}m · NEXT ${this.nextMilestone}m`
        : `HEIGHT ${this.heightMaxReached}m${aiHeightStr} · NEXT ${this.nextMilestone}m · BEST COMBO x${Math.max(this.saveData.bestCombo, this.bestCombo)}`;
    }

    if (this.hudAiBadge) {
      if (this.aiGhostEnabled) {
        this.hudAiBadge.classList.remove("hidden");
      } else {
        this.hudAiBadge.classList.add("hidden");
      }
    }
    this.updateComboHud(this.simState?.comboMultiplier ?? 1);

    const djCharges = this.simState?.player.doubleJumpCharges ?? 0;
    this.doubleJumpFlashTimer = Math.max(0, this.doubleJumpFlashTimer - dt);
    this.updatePowerupSlot(this.hudDoubleJumpCharges, djCharges, this.lastDoubleJumpCharges);
    if (djCharges !== this.lastDoubleJumpCharges) {
      this.pulsePowerupSlot(this.hudDoubleJumpCharges);
      this.lastDoubleJumpCharges = djCharges;
    }

    const shieldCount = this.simState?.player.shieldCount ?? 0;
    this.shieldFlashTimer = Math.max(0, this.shieldFlashTimer - dt);
    this.updatePowerupSlot(this.hudShieldCount, shieldCount, this.lastShieldCount);
    if (shieldCount !== this.lastShieldCount) {
      this.pulsePowerupSlot(this.hudShieldCount);
      this.lastShieldCount = shieldCount;
    }
    this.updateComboGlow(this.simState?.comboMultiplier ?? 1);

    this.toastTimer = Math.max(0, this.toastTimer - dt);
    const toastVisible = this.toastTimer > 0;
    const visibility = Math.min(this.toastTimer / 0.9, 1);
    this.hudToast.style.opacity = toastVisible ? String(visibility) : "0";
    this.hudToast.style.transform = `translate(-50%, ${toastVisible ? (1 - visibility) * 10 : 12}px)`;

    this.zoneAnnouncementTimer = Math.max(0, this.zoneAnnouncementTimer - dt);
    const zoneVisible = this.zoneAnnouncementTimer > 0;
    const fadeDuration = 0.35;
    const fadeIn = Math.min((this.zoneAnnouncementDuration - this.zoneAnnouncementTimer) / fadeDuration, 1);
    const fadeOut = Math.min(this.zoneAnnouncementTimer / fadeDuration, 1);
    const zoneOpacity = zoneVisible ? Math.min(fadeIn, fadeOut) : 0;
    this.zoneAnnouncement.style.opacity = String(zoneOpacity);
    this.zoneAnnouncement.style.transform = `translate(-50%, ${zoneVisible ? (1 - zoneOpacity) * 12 : 12}px)`;

    this.updateScorePops(dt);
  }

  private updatePowerupSlot(slot: HTMLElement, count: number, previousCount: number) {
    const countEl = slot.querySelector<HTMLElement>('[data-role="count"]');
    if (count > 0) {
      slot.classList.remove("empty");
      if (countEl) {
        countEl.textContent = `×${count}`;
      }
    } else {
      slot.classList.add("empty");
      if (countEl) {
        countEl.textContent = "—";
      }
    }
    void previousCount;
  }

  private pulsePowerupSlot(slot: HTMLElement) {
    // Pickup burst bundle:
    //   1. Scale burst 1.0 → 1.3 → 1.0 over 250ms (ease-out-back).
    //   2. 180ms amber glow behind the pill via CSS class toggle.
    //   3. Short line from the player's projected screen pos to the pill center (300ms).
    slot.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.3)" },
        { transform: "scale(1)" },
      ],
      { duration: 250, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
    );
    slot.classList.add("hud-powerup-pulse");
    window.setTimeout(() => slot.classList.remove("hud-powerup-pulse"), 180);
    this.flashPlayerToSlotLine(slot);
  }

  private flashPlayerToSlotLine(slot: HTMLElement) {
    const line = this.hudPickupLine;
    const svg = this.hudOverlaySvg;
    if (!line || !svg) {
      return;
    }
    // Project player world position to screen coords.
    const projected = this.player.mesh.position.clone();
    projected.y += 0.5; // roughly chest height
    projected.project(this.camera);
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const playerX = (projected.x * 0.5 + 0.5) * viewportW;
    const playerY = (-projected.y * 0.5 + 0.5) * viewportH;

    const rect = slot.getBoundingClientRect();
    const slotX = rect.left + rect.width / 2;
    const slotY = rect.top + rect.height / 2;

    // Ergonomic skip: don't draw if the pill is >60% of viewport away from the player.
    const dx = slotX - playerX;
    const dy = slotY - playerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const viewportDiag = Math.sqrt(viewportW * viewportW + viewportH * viewportH);
    if (distance > viewportDiag * 0.6) {
      return;
    }

    line.setAttribute("x1", String(playerX));
    line.setAttribute("y1", String(playerY));
    line.setAttribute("x2", String(slotX));
    line.setAttribute("y2", String(slotY));
    // Ensure a clean transition by resetting opacity quickly, then fading.
    line.style.transition = "none";
    line.style.opacity = "0.85";
    // Force a reflow so the next transition applies.
    void line.getBoundingClientRect();
    line.style.transition = "opacity 300ms ease-out";
    line.style.opacity = "0";
  }

  private updateComboHud(multiplier: number) {
    if (multiplier > 1) {
      this.hudCombo.textContent = `COMBO x${multiplier}`;
      this.hudCombo.classList.add("active");
      if (multiplier > this.lastComboMultiplier) {
        this.hudCombo.animate(
          [
            { transform: "scale(1)", textShadow: "0 0 12px rgba(127, 214, 255, 0.65), 0 0 24px rgba(127, 214, 255, 0.35)" },
            { transform: "scale(1.16)", textShadow: "0 0 24px rgba(255, 255, 255, 0.92), 0 0 40px rgba(255, 212, 120, 0.7)" },
            { transform: "scale(1)", textShadow: "0 0 18px rgba(127, 214, 255, 0.8), 0 0 32px rgba(127, 214, 255, 0.5)" },
          ],
          { duration: 230, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
      }
    } else {
      this.hudCombo.textContent = "";
      this.hudCombo.classList.remove("active");
    }
    this.lastComboMultiplier = multiplier;
  }

  private updateComboGlow(multiplier: number) {
    if (multiplier <= 1) {
      this.comboGlowOverlay.style.opacity = "0";
      return;
    }

    let color = "184, 115, 51";
    if (multiplier >= 7) {
      color = "242, 246, 255";
    } else if (multiplier >= 4) {
      color = "255, 206, 92";
    }

    const intensity = THREE.MathUtils.clamp((multiplier - 1) / 6, 0, 1);
    const opacity = THREE.MathUtils.clamp(0.08 + intensity * 0.5, 0.08, 0.58);
    this.comboGlowOverlay.style.background = `radial-gradient(circle at center, rgba(255,255,255,0) 55%, rgba(${color}, ${0.12 + intensity * 0.34}) 100%)`;
    this.comboGlowOverlay.style.opacity = String(opacity);
  }

  private spawnScorePop(amount: number) {
    if (amount <= 0) {
      return;
    }

    while (this.scorePops.length >= 8) {
      const expired = this.scorePops.shift();
      if (expired) {
        expired.element.remove();
      }
    }

    const hudRect = this.hud.getBoundingClientRect();
    const scoreRect = this.hudScore.getBoundingClientRect();
    const element = document.createElement("div");
    element.textContent = `+${amount}`;
    element.style.position = "absolute";
    element.style.left = `${scoreRect.left - hudRect.left + scoreRect.width * 0.5}px`;
    element.style.top = `${scoreRect.top - hudRect.top + 8}px`;
    element.style.transform = "translate(-50%, 0) scale(0.9)";
    element.style.color = "#ffd35e";
    element.style.fontSize = "18px";
    element.style.fontWeight = "900";
    element.style.letterSpacing = "2px";
    element.style.textShadow = "0 0 14px rgba(255, 213, 94, 0.72), 0 0 26px rgba(255, 170, 68, 0.35)";
    element.style.pointerEvents = "none";
    element.style.willChange = "transform, opacity";
    this.scorePopLayer.appendChild(element);

    this.scorePops.push({
      element,
      age: 0,
      duration: 0.8,
      left: scoreRect.left - hudRect.left + scoreRect.width * 0.5,
      top: scoreRect.top - hudRect.top + 8,
      value: amount,
    });
  }

  private updateScorePops(dt: number) {
    for (let index = this.scorePops.length - 1; index >= 0; index -= 1) {
      const pop = this.scorePops[index];
      pop.age += dt;
      const progress = THREE.MathUtils.clamp(pop.age / pop.duration, 0, 1);
      const rise = progress * 44;
      const scale = 0.9 + Math.sin(progress * Math.PI) * 0.22;
      pop.element.style.opacity = String(1 - progress);
      pop.element.style.transform = `translate(-50%, ${-rise}px) scale(${scale})`;
      if (progress >= 1) {
        pop.element.remove();
        this.scorePops.splice(index, 1);
      }
    }
  }

  private pulseMilestoneToast() {
    this.hudToast.animate(
      [
        { transform: "translate(-50%, 0) scale(1)" },
        { transform: "translate(-50%, -2px) scale(1.18)" },
        { transform: "translate(-50%, 0) scale(1)" },
      ],
      { duration: 340, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
  }

  private clearScorePops() {
    for (const pop of this.scorePops) {
      pop.element.remove();
    }
    this.scorePops.length = 0;
  }

  /**
   * Multiplayer event toast — creates a fixed-position self-removing div that
   * works from any game state (including Title where the hud toast isn't
   * ticked). Uses gold text + frosted-glass aesthetic by default.
   * @param durationMs Visibility duration in milliseconds (~3000 for lobby events, ~4000 for mid-match).
   * @param color Override CSS color; defaults to lobby gold.
   */
  private showMpToast(text: string, durationMs: number, color = "#ffe19d"): void {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      top: "72px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 22px",
      borderRadius: "999px",
      border: "1px solid rgba(255, 225, 157, 0.4)",
      background: "rgba(18, 12, 4, 0.88)",
      backdropFilter: "blur(8px)",
      color,
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: "13px",
      fontWeight: "700",
      letterSpacing: "2px",
      zIndex: "1100",
      pointerEvents: "none",
      textAlign: "center",
      whiteSpace: "nowrap",
    } as CSSStyleDeclaration);
    el.textContent = text;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), durationMs);
  }

  private showToast(message: string) {
    // Suppress HUD toasts during game-over so they never overlap the overlay
    if (this.state === GameState.GameOver) {
      return;
    }
    this.hudToast.style.color = "#aef0ff";
    this.hudToast.style.borderColor = "rgba(122, 223, 255, 0.32)";
    this.hudToast.style.background = "rgba(10, 21, 28, 0.8)";
    this.hudToast.textContent = message;
    this.toastTimer = 1.3;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
  }

  private showAchievementToast(label: string) {
    // While the game-over overlay is visible, suppress toasts (they would
    // overlap the card) and render into the #gameover-unlocks row instead.
    // Queue the label so we can re-emit as a toast when the overlay is
    // dismissed — that way the unlock is never silently lost.
    if (this.state === GameState.GameOver) {
      if (!this.achievementUnlockQueue.includes(label)) {
        this.achievementUnlockQueue.push(label);
      }
      this.renderGameOverUnlocks();
      playAchievementUnlock();
      return;
    }
    this.hudToast.style.color = "#ffd080";
    this.hudToast.style.borderColor = "rgba(255, 196, 120, 0.45)";
    this.hudToast.style.background = "rgba(28, 18, 10, 0.88)";
    this.hudToast.textContent = `⚙ ACHIEVEMENT · ${label}`;
    this.toastTimer = 2.0;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
    playAchievementUnlock();
  }

  private renderGameOverUnlocks(): void {
    const el = document.getElementById("gameover-unlocks");
    if (!el) return;
    if (this.achievementUnlockQueue.length === 0) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.classList.remove("hidden");
    const rows = this.achievementUnlockQueue
      .map((label) => `
        <div class="gameover-unlock-row">
          <span style="color:#ffd35e;">⚙</span>
          <span>${escapeHtml(label)}</span>
        </div>
      `)
      .join("");
    el.innerHTML = `
      <div class="gameover-unlocks-heading">UNLOCKED THIS RUN</div>
      ${rows}
    `;
  }

  private renderGameOverContracts(): void {
    const el = document.getElementById("gameover-contracts");
    if (!el) return;
    if (this.isDailyChallenge || this.activeContracts.length === 0) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const completed = this.activeContracts.filter((c) => c.complete);
    const incomplete = this.activeContracts.filter((c) => !c.complete);
    const rows = [
      ...completed.map((c) => `
        <div class="gameover-contract-row complete">
          <span style="color:#9aff9a;">✓</span>
          <span style="color:#cfeed0; text-decoration:line-through;">${escapeHtml(c.def.label)}</span>
          <span style="color:#9aff9a; font-weight:700;">+${c.def.reward}</span>
        </div>
      `),
      ...incomplete.map((c) => `
        <div class="gameover-contract-row">
          <span style="color:#c7a271;">◯</span>
          <span style="color:#f3d7b1;">${escapeHtml(c.def.label)}</span>
          <span style="color:#c7a271; font-weight:700; font-size:10px;">${formatContractProgress(c)}</span>
        </div>
      `),
    ].join("");
    const bonusLine = this.contractBonus > 0
      ? `<div class="gameover-contracts-bonus">CONTRACT BONUS · +${this.contractBonus}</div>`
      : "";
    el.classList.remove("hidden");
    el.innerHTML = `
      <div class="gameover-contracts-heading">RUN CONTRACTS · ${completed.length}/${this.activeContracts.length}</div>
      ${rows}
      ${bonusLine}
    `;
  }

  private flushAchievementUnlockQueue(): void {
    if (this.achievementUnlockQueue.length === 0) return;
    // Re-emit each queued unlock as a toast with a stagger so they're
    // readable. We deliberately do NOT gate on state here — the player has
    // dismissed the overlay (returnToTitle or startGame), so toasts are
    // appropriate for both Title and Playing states.
    const queued = this.achievementUnlockQueue.slice();
    this.achievementUnlockQueue.length = 0;
    queued.forEach((label, index) => {
      setTimeout(() => {
        if (this.state === GameState.GameOver) {
          // Somehow ended up back on game-over before flush completed —
          // push back into the queue rather than dropping.
          if (!this.achievementUnlockQueue.includes(label)) {
            this.achievementUnlockQueue.push(label);
          }
          this.renderGameOverUnlocks();
          return;
        }
        this.hudToast.style.color = "#ffd080";
        this.hudToast.style.borderColor = "rgba(255, 196, 120, 0.45)";
        this.hudToast.style.background = "rgba(28, 18, 10, 0.88)";
        this.hudToast.textContent = `⚙ ACHIEVEMENT · ${label}`;
        this.toastTimer = 2.0;
        this.hudToast.style.opacity = "1";
        this.hudToast.style.transform = "translate(-50%, 0)";
        playAchievementUnlock();
      }, index * 2300);
    });
  }

  private showZoneAnnouncement(text: string) {
    this.zoneAnnouncement.textContent = text;
    this.zoneAnnouncementTimer = this.zoneAnnouncementDuration;
    this.zoneAnnouncement.style.opacity = "1";
    this.zoneAnnouncement.style.transform = "translate(-50%, 0)";
  }

  private updateEnvironment(height: number) {
    type Zone = {
      height: number;
      bg: number;
      fogDensity: number;
      ambient: number;
      ambientIntensity: number;
      bloom: number;
      name: string;
    };
    // Five dramatically distinct biomes — hue family per band so transitions
    // read as obvious zone shifts during a 60s climb video:
    //   amber → teal → gold → icy-blue → magenta
    const zones: Zone[] = [
      // Band 0 (0–25m) — Workshop: smoky amber workshop, dense fog, hot glow
      { height: 0,   bg: 0x2d1205, fogDensity: 0.024, ambient: 0xff8020, ambientIntensity: 0.85, bloom: 0.22, name: "Workshop" },
      // Band 1 (25–50m) — Storm Deck: cool slate-teal, heavy overcast, exposed
      { height: 25,  bg: 0x041520, fogDensity: 0.016, ambient: 0x30a8c8, ambientIntensity: 1.15, bloom: 0.28, name: "Storm Deck" },
      // Band 2 (50–75m) — Brass Cathedral: olive-green, saturated gold light, tall reverb
      { height: 50,  bg: 0x1c2e04, fogDensity: 0.010, ambient: 0xd4b800, ambientIntensity: 1.50, bloom: 0.38, name: "Brass Cathedral" },
      // Band 3 (75–100m) — Chrome Spire: blue-grey steel, thin airy fog, icy bright
      { height: 75,  bg: 0x182840, fogDensity: 0.005, ambient: 0xa8d4ff, ambientIntensity: 2.20, bloom: 0.50, name: "Chrome Spire" },
      // Band 4 (100m+) — Cosmic Void: deep indigo, near-zero fog, vivid magenta rim
      { height: 100, bg: 0x0e0620, fogDensity: 0.002, ambient: 0xd040f0, ambientIntensity: 1.80, bloom: 0.60, name: "Cosmic Void" },
    ];

    // Fire zone-entry banner once per zone boundary crossing.
    let currentZoneIndex = 0;
    for (let i = zones.length - 1; i >= 0; i -= 1) {
      if (height >= zones[i].height) {
        currentZoneIndex = i;
        break;
      }
    }
    if (currentZoneIndex !== this.lastAnnouncedZone) {
      this.lastAnnouncedZone = currentZoneIndex;
      this.showZoneAnnouncement(zones[currentZoneIndex].name.toUpperCase());
    }

    let from = zones[0];
    let to = zones[0];
    let t = 0;
    for (let index = 0; index < zones.length - 1; index += 1) {
      const a = zones[index];
      const b = zones[index + 1];
      if (height <= a.height) {
        from = a;
        to = a;
        t = 0;
        break;
      }
      const bandStart = b.height - 5;
      if (height < bandStart) {
        from = a;
        to = a;
        t = 0;
        break;
      }
      if (height <= b.height) {
        from = a;
        to = b;
        t = (height - bandStart) / 5;
        break;
      }
      if (index === zones.length - 2) {
        from = b;
        to = b;
      }
    }

    t = THREE.MathUtils.clamp(t, 0, 1);
    this.zoneBgColor.setHex(from.bg);
    this.zoneNextBgColor.setHex(to.bg);
    this.currentFogColor.copy(this.zoneBgColor).lerp(this.zoneNextBgColor, t);
    // scene.background stays black — skydome covers the visible field.
    this.sceneBackgroundColor.copy(this.currentFogColor);

    if (this.scene.fog instanceof THREE.FogExp2) {
      // Fog color tracks the dark base of the current biome (the "deep" tone of the noise sky).
      this.scene.fog.color.copy(this.currentFogColor);
      this.scene.fog.density = THREE.MathUtils.lerp(from.fogDensity, to.fogDensity, t);
    }

    this.zoneAmbientColor.setHex(from.ambient);
    this.zoneNextAmbientColor.setHex(to.ambient);
    this.currentAmbientColor.copy(this.zoneAmbientColor).lerp(this.zoneNextAmbientColor, t);
    this.ambientLight.color.copy(this.currentAmbientColor);
    this.ambientLight.intensity = THREE.MathUtils.lerp(from.ambientIntensity, to.ambientIntensity, t);

    this.bloomPass.strength = THREE.MathUtils.lerp(from.bloom, to.bloom, t) + this.challengeZoneBloomBoost;

    // Skydome: drive highlight color from ambient each frame (already smoothly lerped).
    if (this.skydomeShaderMat) {
      this.skydomeShaderMat.uniforms.uBiomeColor.value.copy(this.currentAmbientColor).multiplyScalar(0.35);
    }

    // Biome particle + skydome cross-fade: detect zone change and start a 2-second lerp.
    if (currentZoneIndex !== this.lastBiomeParticleIndex) {
      this.lastBiomeParticleIndex = currentZoneIndex;
      const cfg = BIOME_PARTICLE_CONFIGS[currentZoneIndex];
      this.biomeParticleFromColor.copy(this.biomeParticleCurrentColor);
      this.biomeParticleToColor.setHex(cfg.color);
      this.biomeParticleFromOpacity = this.biomeParticleCurrentOpacity;
      this.biomeParticleToOpacity = cfg.opacity;
      this.biomeParticleFromSpeed = this.biomeParticleCurrentSpeed;
      this.biomeParticleToSpeed = cfg.speed;
      this.biomeFlickerFreq = cfg.flickerFreq;
      this.biomeParticleLerpStart = this.elapsedTime;

      // Skydome motion parameters cross-fade alongside particles.
      const sdCfg = BIOME_SKYDOME_CONFIGS[currentZoneIndex];
      this.skydomeFromScrollSpeed = this.skydomeCurrentScrollSpeed;
      this.skydomeToScrollSpeed = sdCfg.scrollSpeed;
      this.skydomeFromPulseFreq = this.skydomeCurrentPulseFreq;
      this.skydomeToPulseFreq = sdCfg.pulseFreq;
      this.skydomeLerpStart = this.elapsedTime;
    }
  }

  private updatePlayerLight(dt: number) {
    const lightLerp = 1 - Math.exp(-dt * 5);
    this.playerLight.position.x = THREE.MathUtils.lerp(this.playerLight.position.x, this.player.mesh.position.x, lightLerp);
    this.playerLight.position.y = THREE.MathUtils.lerp(this.playerLight.position.y, this.player.mesh.position.y + 3.2, lightLerp);
    this.playerLight.position.z = THREE.MathUtils.lerp(this.playerLight.position.z, this.player.mesh.position.z + 2.6, lightLerp);
  }

  private triggerMilestoneActivation(height: number) {
    let bestGear: Gear | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const gear of this.visualGearMap.values()) {
      if (gear.variant !== "milestone") {
        continue;
      }
      const delta = Math.abs(gear.mesh.position.y - height);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestGear = gear;
      }
    }

    if (bestGear && bestDelta < 6) {
      bestGear.triggerMilestoneActivation();
    }
  }

  private triggerLandingShake(strength: number) {
    this.cameraShakeOffset.set(
      randomRange(-strength, strength),
      randomRange(-strength * 0.65, strength * 0.65),
      randomRange(-strength, strength)
    );
    this.cameraShakeTimer = this.cameraShakeDuration;
  }

  private triggerCloseCallFlash() {
    this.closeCallFlashTimer = 0.2;
    this.closeCallOverlay.style.opacity = "1";
  }

  private triggerShieldSaveFlash() {
    this.shieldSaveFlashTimer = 0.8;
    this.shieldSaveOverlay.style.opacity = "0.5";
  }

  private updateAirborneTrail(dt: number, state: SimState) {
    if (!state.player.onGround) {
      this.trailWispTimer -= dt;
      if (this.trailWispTimer <= 0) {
        this.trailWispTimer = 0.07;
        this.landingEffectPosition.set(state.player.x, state.player.y, state.player.z);
        this.particles.spawnTrailWisp(this.landingEffectPosition);
      }
    } else {
      this.trailWispTimer = 0;
    }
  }

  private updateSteam(dt: number) {
    this.steamSpawnTimer -= dt;
    while (this.steamSpawnTimer <= 0) {
      this.spawnSteamPuff();
      this.steamSpawnTimer += randomRange(0.5, 1);
    }

    if (this.closeCallFlashTimer > 0) {
      this.closeCallFlashTimer = Math.max(0, this.closeCallFlashTimer - dt);
      const opacity = THREE.MathUtils.clamp(this.closeCallFlashTimer / 0.2, 0, 1);
      this.closeCallOverlay.style.opacity = String(opacity);
    } else {
      this.closeCallOverlay.style.opacity = "0";
    }

    if (this.shieldSaveFlashTimer > 0) {
      this.shieldSaveFlashTimer = Math.max(0, this.shieldSaveFlashTimer - dt);
      const opacity = THREE.MathUtils.clamp(this.shieldSaveFlashTimer / 0.8, 0, 1) * 0.5;
      this.shieldSaveOverlay.style.opacity = String(opacity);
    } else {
      this.shieldSaveOverlay.style.opacity = "0";
    }
  }

  private spawnSteamPuff() {
    this.steamSpawnPosition.set(
      this.camera.position.x + randomRange(-12, 12),
      this.camera.position.y - randomRange(9, 14),
      this.camera.position.z + randomRange(-12, 12)
    );
    this.particles.spawnSteamPuff(this.steamSpawnPosition);

    if (Math.random() < 0.3) {
      const distance = this.steamSpawnPosition.distanceTo(this.player.mesh.position);
      playSteamHiss(distance);
    }
  }

  private onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    this.applyHudRailState();
  }

  private pauseAnimationLoop() {
    if (!this.animationLoopRunning) {
      return;
    }

    this.renderer.setAnimationLoop(null);
    this.animationLoopRunning = false;
    this.clock.stop();
  }

  private resumeAnimationLoop() {
    if (this.animationLoopRunning) {
      return;
    }

    this.clock.start();
    this.renderer.setAnimationLoop(this.animationLoop);
    this.animationLoopRunning = true;
  }

  private getMaxGearHeight(state: SimState): number {
    let maxHeight = 0;
    for (const gear of state.gears) {
      maxHeight = Math.max(maxHeight, gear.y);
    }
    return maxHeight;
  }

  // ── Biome ambient particles ────────────────────────────────────────────────

  private initBiomeParticles(): void {
    const COUNT = 150;
    const pos = this.biomeParticlePositions;
    const speeds = this.biomeParticleSpeeds;
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;

    for (let i = 0; i < COUNT; i++) {
      pos[i * 3]     = cx + randomRange(-16, 16);
      pos[i * 3 + 1] = cy + randomRange(-12, 20);
      pos[i * 3 + 2] = cz + randomRange(-26, 8);
      speeds[i] = randomRange(0.5, 2.0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(0xff5010), // Workshop amber initial
      size: 0.38,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.17, // Workshop starting opacity (matches BIOME_PARTICLE_CONFIGS[0])
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = -900; // behind most scene objects
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.biomeParticles = pts;
    this.biomeParticleGeo = geo;
  }

  private updateBiomeParticles(dt: number): void {
    if (!this.biomeParticles || !this.biomeParticleGeo) {
      return;
    }

    const COUNT = 150;
    const LERP_DUR = 2.0;
    const raw = Math.min((this.elapsedTime - this.biomeParticleLerpStart) / LERP_DUR, 1);
    const st = raw * raw * (3 - 2 * raw); // smoothstep

    this.biomeParticleCurrentColor.copy(this.biomeParticleFromColor).lerp(this.biomeParticleToColor, st);
    this.biomeParticleCurrentOpacity = THREE.MathUtils.lerp(this.biomeParticleFromOpacity, this.biomeParticleToOpacity, st);
    this.biomeParticleCurrentSpeed = THREE.MathUtils.lerp(this.biomeParticleFromSpeed, this.biomeParticleToSpeed, st);

    const mat = this.biomeParticles.material as THREE.PointsMaterial;
    mat.color.copy(this.biomeParticleCurrentColor);
    let opacity = this.biomeParticleCurrentOpacity;
    if (this.biomeFlickerFreq > 0) {
      // Storm Deck: fast staccato blink; Cosmic Void: slow glow pulse
      opacity *= 0.55 + 0.45 * Math.abs(Math.sin(this.elapsedTime * this.biomeFlickerFreq));
    }
    mat.opacity = opacity;

    const pos = this.biomeParticlePositions;
    const speeds = this.biomeParticleSpeeds;
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;
    const top = cy + 20;
    const bot = cy - 12;

    for (let i = 0; i < COUNT; i++) {
      const idx = i * 3;
      pos[idx + 1] += speeds[i] * this.biomeParticleCurrentSpeed * dt;

      if (
        pos[idx + 1] > top ||
        Math.abs(pos[idx] - cx) > 20 ||
        Math.abs(pos[idx + 2] - cz) > 30
      ) {
        pos[idx]     = cx + randomRange(-16, 16);
        pos[idx + 1] = bot + randomRange(0, 5);
        pos[idx + 2] = cz + randomRange(-26, 8);
      }
    }
    this.biomeParticleGeo.attributes.position.needsUpdate = true;
  }

  private updateSkydome(dt: number): void {
    if (!this.skydomeMesh || !this.skydomeShaderMat) {
      return;
    }

    // Follow camera position so the dome is always centered on the viewer.
    // Don't parent — copy position each frame so world-space noise directions
    // remain stable as the camera translates (no parenting = no rotation coupling).
    this.skydomeMesh.position.copy(this.camera.position);

    const uniforms = this.skydomeShaderMat.uniforms;
    uniforms.uTime.value = this.elapsedTime;

    // Lerp scroll speed and pulse freq over 2 seconds when biome changes.
    const LERP_DUR = 2.0;
    const raw = Math.min((this.elapsedTime - this.skydomeLerpStart) / LERP_DUR, 1);
    const st = raw * raw * (3 - 2 * raw); // smoothstep
    this.skydomeCurrentScrollSpeed = THREE.MathUtils.lerp(this.skydomeFromScrollSpeed, this.skydomeToScrollSpeed, st);
    this.skydomeCurrentPulseFreq   = THREE.MathUtils.lerp(this.skydomeFromPulseFreq,   this.skydomeToPulseFreq,   st);

    uniforms.uScrollSpeed.value = this.skydomeCurrentScrollSpeed;
    uniforms.uPulseFreq.value   = this.skydomeCurrentPulseFreq;
  }
}

function getRenderedGearY(gear: SimGear): number {
  return gear.y - gear.crumbleFallDistance;
}

function getRenderedGearTopY(gear: SimGear): number {
  return getRenderedGearY(gear) + gear.height / 2 + 0.12 + getPistonOffset(gear);
}

function getPistonOffset(gear: SimGear): number {
  if (gear.variant !== "piston") {
    return 0;
  }
  return Math.sin((gear.pistonTime / 1.5) * Math.PI * 2) * 0.15;
}

function getSimGearAngularVelocity(gear: SimGear): number {
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
  // 100m+ ultra-hard
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

// Ambient bokeh particle styles per biome zone (matches zone index in updateEnvironment).
// Opacities faded further (2026-04-23) for softer, more atmospheric look per Tommy feedback.
const BIOME_PARTICLE_CONFIGS = [
  // Workshop (0–25m): warm amber ember sparks
  { color: 0xff5010, opacity: 0.17, speed: 1.3, flickerFreq: 0 },
  // Storm Deck (25–50m): pale blue/white electric sparks — fast staccato flicker
  { color: 0x88ddff, opacity: 0.20, speed: 2.0, flickerFreq: 12 },
  // Brass Cathedral (50–75m): rich gold motes, denser and slower
  { color: 0xffcc20, opacity: 0.20, speed: 0.9, flickerFreq: 0 },
  // Chrome Spire (75–100m): icy cyan/white drifting snow or chrome flecks
  { color: 0xd4f0ff, opacity: 0.16, speed: 0.65, flickerFreq: 0 },
  // Cosmic Void (100m+): magenta/violet points with slow glow pulse
  { color: 0xcc44ff, opacity: 0.22, speed: 1.6, flickerFreq: 2.2 },
] as const;

// Skydome motion parameters per biome zone (scroll speed multiplier, luminance pulse freq Hz).
const BIOME_SKYDOME_CONFIGS = [
  // Workshop (0–25m): calm slow drift
  { scrollSpeed: 1.0, pulseFreq: 0.0 },
  // Storm Deck (25–50m): faster scroll; no luminance flicker (was 6 Hz — read
  // as a broken light). Biome already reads distinct from Workshop via its
  // palette + the 1.5× scroll speed.
  { scrollSpeed: 1.5, pulseFreq: 0.0 },
  // Brass Cathedral (50–75m): calm golden drift
  { scrollSpeed: 1.0, pulseFreq: 0.0 },
  // Chrome Spire (75–100m): calm icy drift
  { scrollSpeed: 1.0, pulseFreq: 0.0 },
  // Cosmic Void (100m+): slow 0.5 Hz luminance pulse (4-second gentle breathe)
  { scrollSpeed: 1.0, pulseFreq: 0.5 },
] as const;

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function setPrivate(target: object, key: string, value: boolean | number) {
  (target as Record<string, boolean | number>)[key] = value;
}

function dtZero(): number {
  return 0;
}

function createPowerUpMesh(type: SimPowerUp["type"]): THREE.Mesh {
  const colorMap: Record<SimPowerUp["type"], number> = {
    bolt_magnet: 0xffcc00,
    slow_mo: 0x4488ff,
    shield: 0xff8844,
    double_jump: 0x6ee7ff,
    gear_freeze: 0x88ccff,
  };
  const color = colorMap[type];
  const geo = new THREE.OctahedronGeometry(0.35);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.65,
    metalness: 0.6,
    roughness: 0.22,
  });
  return new THREE.Mesh(geo, mat);
}

function getPowerUpDisplayName(type: SimPowerUp["type"]): string {
  switch (type) {
    case "bolt_magnet": return "BOLT MAGNET! (8s)";
    case "slow_mo": return "SLOW-MO! (3s)";
    case "shield": return "SHIELD +1!";
    case "double_jump": return "DOUBLE JUMP UNLOCKED!";
    case "gear_freeze": return "GEAR FREEZE! (6s)";
  }
  return "POWER-UP!";
}

function parseSaveData(rawSave: string | null): SaveData {
  if (!rawSave) {
    return { ...DEFAULT_SAVE_DATA };
  }

  try {
    const parsed = JSON.parse(rawSave) as Partial<SaveData>;
    return {
      bestScore: finiteOr(parsed.bestScore, DEFAULT_SAVE_DATA.bestScore),
      bestHeight: finiteOr(parsed.bestHeight, DEFAULT_SAVE_DATA.bestHeight),
      bestCombo: Math.max(1, finiteOr(parsed.bestCombo, DEFAULT_SAVE_DATA.bestCombo)),
      totalRuns: finiteOr(parsed.totalRuns, DEFAULT_SAVE_DATA.totalRuns),
      totalBolts: finiteOr(parsed.totalBolts, DEFAULT_SAVE_DATA.totalBolts),
      totalPlaytime: finiteOr(parsed.totalPlaytime, DEFAULT_SAVE_DATA.totalPlaytime),
      audioEnabled: typeof parsed.audioEnabled === "boolean" ? parsed.audioEnabled : DEFAULT_SAVE_DATA.audioEnabled,
    };
  } catch {
    return { ...DEFAULT_SAVE_DATA };
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatAchievementId(value: string): string {
  return value.replaceAll("_", " ");
}
