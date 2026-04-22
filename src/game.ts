import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  getAudioEnabled,
  initAudio,
  playAchievementUnlock,
  playClick,
  playCollect,
  playComboLand,
  playGearBonk,
  playGearTick,
  playHit,
  playJump,
  playLand,
  playMilestone,
  playPistonLaunch,
  playSteamHiss,
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
  submitScores,
  unlockAchievement,
  updateStat,
  writeSaveData,
} from "./platform";
import type { AchievementProgress } from "./platform";
import { AIGhost, isAIGhostEnabled } from "./ai-ghost";
import { MultiplayerManager, type PeerGhost } from "./multiplayer";
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
  private readonly sim = new ClockworkClimbSimulation();
  private simState: SimState | null = null;
  private state = GameState.Title;
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
  private closeCallOverlay!: HTMLElement;
  private shieldSaveOverlay!: HTMLElement;
  private tutorialOverlay!: HTMLElement;
  private tutorialControls!: HTMLElement;
  private tutorialObjective!: HTMLElement;
  private titleHeading!: HTMLElement;
  private titleTagline!: HTMLElement;
  private titleBest!: HTMLElement;
  private titlePrompt!: HTMLElement;
  private gameOverCard!: HTMLElement;
  private shareScoreBtn!: HTMLButtonElement;
  private achievementsButton: HTMLButtonElement | null = null;
  private achievementsPanel: HTMLDivElement | null = null;
  private titleBackButton: HTMLButtonElement | null = null;
  private pauseTitleBtn: HTMLButtonElement | null = null;
  private achievementCatalog: AchievementCatalogEntry[] = [];
  private gameOverHeightEl!: HTMLElement;
  private gameOverBoltsEl!: HTMLElement;
  private gameOverBoltCountEl!: HTMLElement;
  private gameOverComboEl!: HTMLElement;
  private gameOverTimeEl!: HTMLElement;
  private gameOverTotalEl!: HTMLElement;
  private zoneAnnouncement!: HTMLElement;
  private pauseOverlay!: HTMLElement;
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
  private multiplayerPanel: HTMLDivElement | null = null;
  private multiplayerButton: HTMLButtonElement | null = null;
  private multiplayerStatus: HTMLDivElement | null = null;
  private multiplayerInviteBtn: HTMLButtonElement | null = null;
  private multiplayerStartBtn: HTMLButtonElement | null = null;
  private multiplayerLeaveBtn: HTMLButtonElement | null = null;
  private multiplayerLabelLayer: HTMLDivElement | null = null;
  private multiplayerLobbyVisible = false;
  private multiplayerInviteUrl: string | null = null;
  private readonly ghostTmpVec = new THREE.Vector3();
  private readonly backgroundGroup = new THREE.Group();
  private readonly titleBackdropGroup = new THREE.Group();
  private backgroundDecorations: BackgroundDecoration[] = [];
  private titleBackdropDecorations: TitleBackdropDecoration[] = [];
  private readonly gearTickNextTimes = new Map<number, number>();
  // Per-gear squash animation time (seconds since landing) for bouncy gears.
  private readonly bouncyGearSquashTimers = new Map<number, number>();
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
  private seenWindGear = false;
  private seenMagnetGear = false;
  private seenGearFreeze = false;
  private windParticleTimer = 0;
  private magnetParticleTimer = 0;
  private gearFreezeParticleTimer = 0;
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
    this.scene.background = new THREE.Color(0x140d0a);
    this.scene.fog = new THREE.FogExp2(0x140d0a, 0.014);
    this.scene.add(this.titleBackdropGroup);

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
    this.landingCueGroup.add(this.landingCueGlow, this.landingCueRing, this.landingCueCore);
    this.landingCueGroup.rotation.x = -Math.PI / 2;
    this.landingCueGroup.visible = false;
    this.landingCueGlow.renderOrder = 11;
    this.landingCueRing.renderOrder = 12;
    this.landingCueCore.renderOrder = 13;
    this.scene.add(this.landingCueGroup);
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
      const text = `I scored ${this.score} climbing ${this.heightMaxReached}m in Clockwork Climb! ⚙️\nCan you beat my score?\n#gamedevjs #gamedev @tommyatoai`;
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
    void this.loadAchievementCatalog();
    this.setupMultiplayerUi(container);
    this.initAIGhost();
    this.setupAIGhostButton();
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
    await signalLoadComplete();
  }

  private createLeaderboardPanels() {
    this.titleLeaderboardPanel = this.buildLeaderboardPanel("TOP 10 SCORES");
    this.titleLeaderboardContext = this.titleLeaderboardPanel.querySelector("[data-role='context']") as HTMLElement;
    this.titleLeaderboardThreshold = this.titleLeaderboardPanel.querySelector("[data-role='threshold']") as HTMLElement;
    this.titleLeaderboardList = this.titleLeaderboardPanel.querySelector("[data-role='list']") as HTMLElement;
    this.titleLeaderboardPanel.style.position = "absolute";
    this.titleLeaderboardPanel.style.right = "20px";
    this.titleLeaderboardPanel.style.bottom = "24px";
    this.titleLeaderboardPanel.style.width = "min(340px, calc(100vw - 40px))";
    this.titleOverlay.appendChild(this.titleLeaderboardPanel);

    this.gameOverLeaderboardPanel = this.buildLeaderboardPanel("RUN CONTEXT");
    this.gameOverLeaderboardContext = this.gameOverLeaderboardPanel.querySelector("[data-role='context']") as HTMLElement;
    this.gameOverLeaderboardThreshold = this.gameOverLeaderboardPanel.querySelector("[data-role='threshold']") as HTMLElement;
    this.gameOverLeaderboardList = this.gameOverLeaderboardPanel.querySelector("[data-role='list']") as HTMLElement;
    this.gameOverLeaderboardPanel.style.marginTop = "0";
    this.gameOverLeaderboardPanel.style.marginBottom = "20px";
    this.gameOverLeaderboardPanel.style.width = "min(400px, calc(100vw - 40px))";
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.titleOverlay.insertBefore(this.gameOverLeaderboardPanel, this.shareScoreBtn);
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

  private async refreshLeaderboardPanels() {
    const entries = await fetchLeaderboardScores();
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
      `THIS RUN ${this.score} · BEST ${this.saveData.bestScore}`
    );
    this.gameOverLeaderboardThreshold.textContent = this.getGameOverCallout();
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
    return `CHECKPOINTS · NEXT ${this.nextMilestone}m · ZONES 25/50/75/100`;
  }

  // -----------------------------------------------------------------------
  // Achievements UI
  // -----------------------------------------------------------------------

  private setupAchievementsUi() {
    const button = document.getElementById("achievements-btn") as HTMLButtonElement | null;
    const overlay = document.getElementById("achievements-overlay") as HTMLDivElement | null;
    const closeBtn = document.getElementById("achievements-close") as HTMLButtonElement | null;

    if (!button || !overlay || !closeBtn) {
      return;
    }

    this.achievementsButton = button;
    this.achievementsPanel = overlay;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openAchievementsPanel();
    });
    button.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openAchievementsPanel();
    }, { passive: false });

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

    this.state = GameState.Title;
    this.pauseOverlay.classList.add("hidden");
    this.hud.classList.add("hidden");
    this.gameOverCard.classList.add("hidden");
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.shareScoreBtn.classList.add("hidden");
    this.titleLeaderboardPanel.classList.remove("hidden");
    this.titleOverlay.classList.remove("hidden");
    this.closeCallOverlay.style.opacity = "0";
    this.shieldSaveOverlay.style.opacity = "0";
    this.hideTutorialOverlay(true);
    this.landingCueGroup.visible = false;
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
  }

  // -----------------------------------------------------------------------
  // Multiplayer UI + ghost rendering
  // -----------------------------------------------------------------------

  private setupMultiplayerUi(container: HTMLElement) {
    if (!this.multiplayer.isAvailable()) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "title-action-btn";
    button.textContent = "MULTIPLAYER";
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
    const actions = document.getElementById("title-actions");
    if (actions) {
      actions.appendChild(button);
    } else {
      this.titlePrompt.insertAdjacentElement("afterend", button);
    }

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      marginTop: "12px",
      padding: "16px 18px",
      borderRadius: "18px",
      border: "1px solid rgba(127, 214, 255, 0.32)",
      background: "linear-gradient(180deg, rgba(14, 28, 40, 0.9), rgba(6, 14, 22, 0.78))",
      boxShadow: "0 16px 40px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(173, 232, 255, 0.12)",
      backdropFilter: "blur(10px)",
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      color: "#d7f8ff",
      width: "min(400px, calc(100vw - 40px))",
      textAlign: "center",
      pointerEvents: "auto",
      display: "none",
    } as CSSStyleDeclaration);
    panel.addEventListener("click", (event) => event.stopPropagation());
    panel.addEventListener("touchend", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

    const status = document.createElement("div");
    Object.assign(status.style, {
      fontSize: "12px",
      letterSpacing: "2px",
      color: "#7fd6ff",
      marginBottom: "10px",
    } as CSSStyleDeclaration);
    status.textContent = "WAITING FOR PLAYERS…";
    panel.appendChild(status);
    this.multiplayerStatus = status;

    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, {
      display: "flex",
      gap: "8px",
      justifyContent: "center",
      flexWrap: "wrap",
    } as CSSStyleDeclaration);

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

    const inviteBtn = makePanelButton("COPY INVITE LINK", "rgba(127, 214, 255, 0.42)");
    inviteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.copyInviteLink();
    });
    this.multiplayerInviteBtn = inviteBtn;
    buttonRow.appendChild(inviteBtn);

    const startBtn = makePanelButton("START", "rgba(255, 196, 120, 0.5)");
    startBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startGame();
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
    this.multiplayerPanel = panel;
    button.insertAdjacentElement("afterend", panel);

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
    await this.multiplayer.leaveLobby();
    this.clearGhostMeshes();
    this.multiplayerInviteUrl = null;
    this.hideMultiplayerPanel();
  }

  private showMultiplayerPanel() {
    if (!this.multiplayerPanel) return;
    this.multiplayerPanel.style.display = "block";
    this.multiplayerLobbyVisible = true;
    this.refreshMultiplayerPanel();
  }

  private hideMultiplayerPanel() {
    if (!this.multiplayerPanel) return;
    this.multiplayerPanel.style.display = "none";
    this.multiplayerLobbyVisible = false;
  }

  private setMultiplayerStatus(text: string) {
    if (this.multiplayerStatus) {
      this.multiplayerStatus.textContent = text;
    }
  }

  private refreshMultiplayerPanel() {
    if (!this.multiplayerPanel || !this.multiplayerLobbyVisible) return;
    if (!this.multiplayer.isActive()) {
      this.setMultiplayerStatus("WAITING FOR PLAYERS…");
      return;
    }
    const memberCount = this.multiplayer.getLobbyMemberCount();
    const peerCount = this.multiplayer.getPeerCount();
    const total = Math.max(memberCount, peerCount + 1);
    this.setMultiplayerStatus(
      total > 1
        ? `PLAYERS IN LOBBY: ${total}/4 · READY TO CLIMB`
        : `LOBBY OPEN · SHARE INVITE LINK · ${total}/4`
    );
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
    if (!this.aiGhostEnabled) return;
    this.aiGhost = new AIGhost("model-weights.json");
    void this.aiGhost.load().then((ok) => {
      if (ok) console.log("[game] AI ghost ready");
    });
  }

  private setupAIGhostButton(): void {
    // FIXME: the AI ghost renders its own (seed=42) sim parallel to the
    // player's run, and in practice the ghost mesh doesn't reliably appear.
    // Disable the button until the feature is fixed so the title screen
    // doesn't advertise something that looks like "just the normal game".
    const AI_GHOST_READY = false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "title-action-btn";
    btn.textContent = AI_GHOST_READY
      ? (this.aiGhostEnabled ? "AI GHOST: ON" : "RACE THE AI")
      : "RACE THE AI · SOON";
    Object.assign(btn.style, {
      border: "1px solid rgba(255, 196, 120, 0.45)",
      background: "linear-gradient(180deg, rgba(46, 32, 14, 0.92), rgba(24, 16, 8, 0.82))",
      boxShadow: "0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255, 226, 176, 0.18)",
      color: "#ffe1a9",
    } as CSSStyleDeclaration);

    if (!AI_GHOST_READY) {
      btn.disabled = true;
      Object.assign(btn.style, {
        opacity: "0.42",
        cursor: "not-allowed",
        filter: "grayscale(0.65)",
        pointerEvents: "none",
      } as CSSStyleDeclaration);
      btn.setAttribute("aria-disabled", "true");
      btn.title = "Race the AI is being re-tuned — coming back soon.";
    } else {
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
    }

    this.aiGhostButton = btn;

    // Append into the title-actions column so it stacks under MULTIPLAYER.
    const actions = document.getElementById("title-actions");
    if (actions) {
      actions.appendChild(btn);
    } else {
      const anchor = this.multiplayerButton ?? this.titlePrompt;
      anchor.insertAdjacentElement("afterend", btn);
    }
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
      this.aiGhost = new AIGhost("model-weights.json");
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
  }

  private resetAIGhost(): void {
    if (!this.aiGhostEnabled || !this.aiGhost?.isReady()) return;
    this.aiGhost.reset();
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
    for (const gear of this.visualGearMap.values()) {
      this.scene.remove(gear.mesh);
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
      { x: -8.4, y: 3.4, z: -13.5, scale: 3.2, rotationSpeed: 0.024, radius: 3.2, color: 0xa16a34, variant: "normal" as GearVariant, bobAmplitude: 0.14, bobPhase: 0.2 },
      { x: -4.8, y: 6.2, z: -14.2, scale: 2.2, rotationSpeed: -0.034, radius: 2.5, color: 0xffa34d, variant: "speed" as GearVariant, bobAmplitude: 0.1, bobPhase: 1.4 },
      { x: 4.8, y: 6.2, z: -14.2, scale: 2.2, rotationSpeed: 0.034, radius: 2.5, color: 0x5d8fb3, variant: "wind" as GearVariant, bobAmplitude: 0.1, bobPhase: 2.6 },
      { x: 8.4, y: 3.4, z: -13.5, scale: 3.2, rotationSpeed: -0.024, radius: 3.2, color: 0x5aa95f, variant: "bouncy" as GearVariant, bobAmplitude: 0.14, bobPhase: 3.1 },
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
    initAudio();
    playClick();
    this.resumeAnimationLoop();
    this.state = GameState.Playing;
    this.runStartElapsedTime = this.elapsedTime;
    this.toastTimer = 0;
    this.zoneAnnouncementTimer = 0;
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
    this.gearFreezeActive = false;
    this.personalBestReachedThisRun = false;
    this.inChallengeZone = false;
    this.closeCallOverlay.style.opacity = "0";
    this.titleOverlay.style.overflowY = "";
    this.player.reset(0, 2);
    this.player.resetVisuals();
    this.resetVisualWorld();

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
    this.gameOverCard.classList.add("hidden");
    this.titleLeaderboardPanel.classList.remove("hidden");
    this.gameOverLeaderboardPanel.classList.add("hidden");
    this.shareScoreBtn.classList.add("hidden");
    this.titleTagline.classList.remove("new-best");
    this.titleBest.classList.add("hidden");
    this.zoneAnnouncement.style.opacity = "0";
    this.zoneAnnouncement.style.transform = "translate(-50%, 12px)";
    this.input.setTouchControlsVisible(this.input.isTouchDevice());
    this.showTutorialOverlay();
    startAmbientTick();
    startMusic();
    this.landingCueGroup.visible = false;

    if (this.personalBestRing) {
      this.personalBestRing.position.set(0, this.personalBestHeight, 0);
      this.personalBestRing.visible = this.personalBestHeight > 0;
      (this.personalBestRing.material as THREE.MeshBasicMaterial).opacity = 0.3;
    }

    this.hideMultiplayerPanel();
    if (this.multiplayerButton) {
      this.multiplayerButton.style.display = "none";
    }
    if (this.aiGhostButton) {
      this.aiGhostButton.style.display = "none";
    }
    this.clearGhostMeshes();
    this.resetAIGhost();
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

    const action: SimAction = {
      moveX: this.input.getMovement().x,
      moveY: this.input.getMovement().y,
      jump: this.input.justPressed("space"),
    };

    const { state, events } = this.sim.step(action, dt);
    this.consumeState(state);
    this.handleEvents(events, state);
    this.updatePlayerVisuals(dt, state.player, state.orbitAngle);
    this.syncVisuals(state);
    this.updateBouncyGearSquashes(dt);
    setTickRate(this.heightMaxReached);
    setMusicIntensity(this.heightMaxReached);
    this.challengeZoneBloomBoost = Math.max(0, this.challengeZoneBloomBoost - dt * 0.7);
    this.updateEnvironment(state.player.y);
    this.updateWorld(dt);
    this.updateCamera(dt, state);
    this.updateLandingCue(state);
    this.updatePersonalBestRing(state.player.y);
    this.updateHud(dt);
    this.tickMultiplayer(dt, state);
    this.updateAIGhost(dt);

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
    this.input.setTouchControlsVisible(false);
    this.hideTutorialOverlay(true);
    this.landingCueGroup.visible = false;
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
    this.closeCallFlashTimer = 0;
    this.shieldSaveFlashTimer = 0;
    this.shieldSaveOverlay.style.opacity = "0";
    this.closeCallOverlay.style.opacity = "0";

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
    void submitScores({
      score: this.score,
      height: this.heightMaxReached,
      combo: this.bestCombo,
    }).catch((error: unknown) => {
      console.error("Failed to submit score", error);
    });
    void this.refreshLeaderboardPanels().catch((error: unknown) => {
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
    this.titleOverlay.classList.remove("hidden");
    this.titleOverlay.classList.add("game-over");
    this.titleOverlay.style.overflowY = "auto";
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
    this.titlePrompt.textContent = "RESTART";

    const gameSeconds = Math.floor(state.gameTime);
    this.gameOverHeightEl.textContent = String(this.heightScore);
    this.gameOverBoltsEl.textContent = String(this.boltScore);
    this.gameOverBoltCountEl.textContent = String(this.boltCount);
    this.gameOverComboEl.textContent = `x${this.bestCombo}`;
    this.gameOverTimeEl.textContent = `${gameSeconds}s`;
    this.gameOverTotalEl.textContent = String(this.score);
    this.renderLeaderboardList(
      this.gameOverLeaderboardContext,
      this.gameOverLeaderboardList,
      this.gameOverLeaderboardEntries,
      `THIS RUN ${this.score} · BEST ${this.saveData.bestScore}`
    );
    this.gameOverCard.classList.remove("hidden");
    this.gameOverLeaderboardPanel.classList.remove("hidden");
    this.shareScoreBtn.classList.remove("hidden");

    if (this.multiplayer.isActive()) {
      this.renderMultiplayerGameOverBoard();
      if (this.multiplayerButton) {
        this.multiplayerButton.style.display = "inline-flex";
      }
      this.showMultiplayerPanel();
    } else if (this.multiplayer.isAvailable()) {
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
      return getUsername();
    } catch {
      return "You";
    }
  }

  private updateGameOver(dt: number) {
    this.updateWorld(dt);
    this.updatePlayerLight(dt);

    if (this.deathAnimTimer > 0) {
      this.deathAnimTimer -= dt;
      this.player.setBodyOpacity(Math.max(0, this.deathAnimTimer / 0.4));
    }

    if (this.multiplayer.isActive()) {
      // Keep peers fresh on the post-run lobby screen — no broadcast
      this.multiplayer.pollPeers(dt);
      this.refreshMultiplayerPanel();
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
    const previousScore = this.score;
    this.score = state.score;
    this.heightScore = state.heightScore;
    this.heightMaxReached = state.heightMaxReached;
    this.boltCount = state.boltCount;
    this.boltScore = state.boltScore;
    this.gameTime = state.gameTime;
    this.nextMilestone = state.nextMilestone;
    this.currentZoneIndex = state.currentZoneIndex;
    this.bestCombo = state.bestCombo;
    this.inChallengeZone = state.inChallengeZone;

    if (state.score > previousScore) {
      this.spawnScorePop(state.score - previousScore);
    }
  }

  private syncVisuals(state: SimState) {
    const nextGearIds = new Set(state.gears.map((gear) => gear.id));
    for (const [id, gear] of this.visualGearMap) {
      if (nextGearIds.has(id)) {
        continue;
      }
      this.scene.remove(gear.mesh);
      this.visualGearMap.delete(id);
      this.gearTickNextTimes.delete(id);
      this.bouncyGearSquashTimers.delete(id);
    }

    for (const simGear of state.gears) {
      let gear = this.visualGearMap.get(simGear.id);
      if (!gear) {
        gear = this.createGearVisual(simGear);
        this.visualGearMap.set(simGear.id, gear);
        this.scene.add(gear.mesh);
        if (this.gearFreezeActive) {
          gear.setFreezeEmissive(true);
        }
      }
      this.applySimGearToVisual(gear, simGear);
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
    const gear = new Gear({
      color: baseColor,
      danger: band.danger,
      height: simGear.height,
      radius: simGear.radius,
      rotationSpeed: simGear.rotationSpeed,
      variant: simGear.variant as GearVariant,
    });
    gear.enableTopDownShadow(this.topDownShadow.uniforms);
    gear.rotationDir = simGear.rotationDir;
    return gear;
  }

  private applySimGearToVisual(gear: Gear, simGear: SimGear) {
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
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.cameraKick = Math.max(this.cameraKick, 0.12);
          break;
        case "gear_block":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnGearBonkSparks(this.landingEffectPosition, event.impactSpeed);
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
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          playJump(1.45);
          this.cameraKick = Math.max(this.cameraKick, 0.18);
          this.player.bouncyLaunch();
          break;
        case "double_jump":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          playJump(1.25);
          this.cameraKick = Math.max(this.cameraKick, 0.16);
          this.doubleJumpFlashTimer = 0.5;
          break;
        case "powerup_collect":
          if (event.powerUpType === "double_jump") {
            this.landingEffectPosition.set(event.x, event.y, event.z);
            this.particles.spawnJumpSparks(this.landingEffectPosition);
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
          this.challengeZoneBloomBoost = 0.18;
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

        if (this.state === GameState.Playing && simGear.active) {
          const distance = gear.mesh.position.distanceTo(this.player.mesh.position);
          if (distance <= 15) {
            const angularSpeed = Math.abs(getSimGearAngularVelocity(simGear));
            if (angularSpeed < 0.05) {
              this.gearTickNextTimes.delete(simGear.id);
              continue;
            }
            const teethInterval = (Math.PI * 2) / Math.max(angularSpeed * Math.max(6, Math.floor(gear.radius * 10)), 0.001);
            const interval = THREE.MathUtils.clamp(teethInterval, 0.25, 1.25);
            const nextTickAt = this.gearTickNextTimes.get(simGear.id) ?? this.elapsedTime + interval;
            if (this.elapsedTime >= nextTickAt) {
              playGearTick(distance, angularSpeed);
              this.gearTickNextTimes.set(simGear.id, this.elapsedTime + interval);
            } else if (!this.gearTickNextTimes.has(simGear.id)) {
              this.gearTickNextTimes.set(simGear.id, nextTickAt);
            }
          } else {
            this.gearTickNextTimes.delete(simGear.id);
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
    this.particles.update(dt, this.player.mesh.position);
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

    this.cameraLookTarget.set(
      playerX,
      playerY + 1.3 + verticalLead * 0.35,
      playerZ
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
  private updateLandingCue(state: SimState) {
    const player = state.player;
    if (player.onGround) {
      this.landingCueGroup.visible = false;
      return;
    }

    // ~20% larger than the base 0.2-radius geometry so the shadow reads as grounded,
    // not as a debug dot. Player radius is 0.3 so this remains modest.
    const BASE_SCALE = 1.2;

    const landingSurface = this.findLandingSurface(state);
    if (!landingSurface) {
      // No landing target below (player over a gap). Instead of hiding the cue — which
      // strips the player of spatial awareness — project it a fixed distance below the
      // player's feet so there is always a visual "down" reference. Render only the
      // soft core at reduced opacity so it reads clearly as "no target" vs. "target".
      this.landingCueGroup.visible = true;
      this.landingCueGroup.position.set(player.x, player.y - 3.0, player.z);
      this.landingCueGroup.scale.setScalar(BASE_SCALE);
      this.landingCueCoreMaterial.opacity = 0.14;
      this.landingCueRingMaterial.opacity = 0;
      this.landingCueGlowMaterial.opacity = 0;
      return;
    }

    const dropHeight = Math.max(0, player.y - landingSurface.y);
    // heightT: 0 = right above landing, 1 = far above (8m+ drop)
    const heightT = THREE.MathUtils.clamp(dropHeight / 8, 0, 1);

    // Core shadow dot: always visible when airborne, the main landing indicator.
    // Slight fade-in as you get closer so it doesn't pop.
    const coreOpacity = THREE.MathUtils.lerp(0.18, 0.42, 1 - heightT);

    // Ring: only visible when FAR from landing (faded out). Hidden when close.
    // Fades in softly as you're still high up, disappears completely near touchdown.
    const ringOpacity = THREE.MathUtils.clamp(heightT * 0.22, 0, 0.22);

    this.landingCueGroup.visible = true;
    this.landingCueGroup.position.set(player.x, landingSurface.y + 0.018, player.z);
    this.landingCueGroup.scale.setScalar(BASE_SCALE);
    this.landingCueCoreMaterial.opacity = coreOpacity;
    this.landingCueRingMaterial.opacity = ringOpacity;
    this.landingCueGlowMaterial.opacity = 0;
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

  private findLandingSurface(state: SimState): { y: number } | null {
    const player = state.player;
    const playerRadius = 0.3;
    let bestY = -Infinity;

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
    }

    return bestY > -Infinity ? { y: bestY } : null;
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
    this.hudStatus.textContent = `HEIGHT ${this.heightMaxReached}m · NEXT ${this.nextMilestone}m · BEST COMBO x${Math.max(this.saveData.bestCombo, this.bestCombo)}`;
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
    // Playful motion: ease-out-back, ~200ms, 15% overshoot.
    slot.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.15)" },
        { transform: "scale(1)" },
      ],
      { duration: 200, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" }
    );
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

  private showToast(message: string) {
    this.hudToast.style.color = "#aef0ff";
    this.hudToast.style.borderColor = "rgba(122, 223, 255, 0.32)";
    this.hudToast.style.background = "rgba(10, 21, 28, 0.8)";
    this.hudToast.textContent = message;
    this.toastTimer = 1.3;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
  }

  private showAchievementToast(label: string) {
    this.hudToast.style.color = "#ffd080";
    this.hudToast.style.borderColor = "rgba(255, 196, 120, 0.45)";
    this.hudToast.style.background = "rgba(28, 18, 10, 0.88)";
    this.hudToast.textContent = `⚙ ACHIEVEMENT · ${label}`;
    this.toastTimer = 2.0;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
    playAchievementUnlock();
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
    };
    const zones: Zone[] = [
      { height: 0, bg: 0x140d0a, fogDensity: 0.014, ambient: 0xc7aa7a, ambientIntensity: 1.0, bloom: 0.18 },
      { height: 25, bg: 0x0f1318, fogDensity: 0.012, ambient: 0x8899bb, ambientIntensity: 1.1, bloom: 0.22 },
      { height: 50, bg: 0x181b22, fogDensity: 0.010, ambient: 0xb8c4dd, ambientIntensity: 1.25, bloom: 0.26 },
      { height: 75, bg: 0x1a1408, fogDensity: 0.008, ambient: 0xffd6a3, ambientIntensity: 1.5, bloom: 0.32 },
      { height: 100, bg: 0x0a0a14, fogDensity: 0.006, ambient: 0xff88aa, ambientIntensity: 1.8, bloom: 0.40 },
    ];

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
    this.sceneBackgroundColor.copy(this.currentFogColor);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.sceneBackgroundColor);
    } else {
      this.scene.background = this.sceneBackgroundColor.clone();
    }

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(this.currentFogColor);
      this.scene.fog.density = THREE.MathUtils.lerp(from.fogDensity, to.fogDensity, t);
    }

    this.zoneAmbientColor.setHex(from.ambient);
    this.zoneNextAmbientColor.setHex(to.ambient);
    this.currentAmbientColor.copy(this.zoneAmbientColor).lerp(this.zoneNextAmbientColor, t);
    this.ambientLight.color.copy(this.currentAmbientColor);
    this.ambientLight.intensity = THREE.MathUtils.lerp(from.ambientIntensity, to.ambientIntensity, t);

    this.bloomPass.strength = THREE.MathUtils.lerp(from.bloom, to.bloom, t) + this.challengeZoneBloomBoost;
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
