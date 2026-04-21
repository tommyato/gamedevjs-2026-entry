import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  getAudioEnabled,
  initAudio,
  playClick,
  playCollect,
  playComboLand,
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
  isAudioEnabled,
  onAudioChange,
  platformInit,
  registerPauseHandlers,
  signalFirstFrame,
  signalGameReady,
  signalLoadComplete,
  submitScore,
  unlockAchievement,
} from "./platform";
import { Player } from "./player";
import { ClockworkClimbSimulation } from "./simulation";
import type { GearVariant, SimAction, SimBolt, SimEvent, SimGear, SimPlayer, SimPowerUp, SimState } from "./sim-types";

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
  private inChallengeZone = false;
  private challengeZoneBloomBoost = 0;

  private hud!: HTMLElement;
  private titleOverlay!: HTMLElement;
  private hudScore!: HTMLElement;
  private hudBest!: HTMLElement;
  private hudBolts!: HTMLElement;
  private hudStatus!: HTMLElement;
  private hudToast!: HTMLElement;
  private hudControls!: HTMLElement;
  private hudCombo!: HTMLElement;
  private soundToggleBtn!: HTMLElement;
  private closeCallOverlay!: HTMLElement;
  private tutorialOverlay!: HTMLElement;
  private tutorialControls!: HTMLElement;
  private tutorialObjective!: HTMLElement;
  private titleHeading!: HTMLElement;
  private titleTagline!: HTMLElement;
  private titleBest!: HTMLElement;
  private titlePrompt!: HTMLElement;
  private gameOverCard!: HTMLElement;
  private shareScoreBtn!: HTMLButtonElement;
  private gameOverHeightEl!: HTMLElement;
  private gameOverBoltsEl!: HTMLElement;
  private gameOverBoltCountEl!: HTMLElement;
  private gameOverComboEl!: HTMLElement;
  private gameOverTimeEl!: HTMLElement;
  private gameOverTotalEl!: HTMLElement;
  private zoneAnnouncement!: HTMLElement;
  private pauseOverlay!: HTMLElement;
  private pauseBtn!: HTMLElement;

  private readonly player = new Player();
  private gears: Gear[] = [];
  private bolts: BoltCollectible[] = [];
  private readonly visualGearMap = new Map<number, Gear>();
  private readonly visualBoltMap = new Map<number, BoltCollectible>();
  private readonly visualPowerUpMap = new Map<number, THREE.Mesh>();
  private towerBase!: THREE.Mesh;
  private playerLight!: THREE.PointLight;
  private playerShadow!: THREE.Mesh;
  private readonly gearShadowMap = new Map<Gear, { mesh: THREE.Mesh; lowerGear: Gear }>();
  private readonly cameraLookTarget = new THREE.Vector3();
  private readonly landingEffectPosition = new THREE.Vector3();
  private readonly steamSpawnPosition = new THREE.Vector3();
  private readonly particles = new ParticleSystem(200);
  private readonly backgroundGroup = new THREE.Group();
  private backgroundDecorations: BackgroundDecoration[] = [];
  private readonly gearTickNextTimes = new Map<number, number>();
  private backgroundGenerationHeight = 0;
  private cameraKick = 0;
  private readonly cameraShakeOffset = new THREE.Vector3();
  private cameraShakeTimer = 0;
  private readonly cameraShakeDuration = 0.15;
  private closeCallFlashTimer = 0;
  private steamSpawnTimer = 0;
  private deathAnimTimer = 0;
  private toastTimer = 0;
  private zoneAnnouncementTimer = 0;
  private readonly zoneAnnouncementDuration = 2;
  private tutorialShown = false;
  private tutorialFadeTimer: number | null = null;
  private tutorialHideTimer: number | null = null;

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
    this.highScore = parseInt(localStorage.getItem("gameHighScore") || "0", 10);

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

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 6.8, 11.2);
    this.camera.lookAt(0, 4, 0);

    const ambient = new THREE.AmbientLight(0xc7aa7a, 1.35);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const hemisphere = new THREE.HemisphereLight(0xf2dcc2, 0x2b1a10, 1.1);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight(0xffd6a3, 2.8);
    keyLight.position.set(8, 18, 10);
    keyLight.castShadow = false;
    keyLight.target.position.set(0, 10, 0);
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);

    const fillLight = new THREE.DirectionalLight(0xb8703a, 1.4);
    fillLight.position.set(-7, 9, -6);
    this.scene.add(fillLight);

    this.playerLight = new THREE.PointLight(0xffc06a, 12, 16, 2);
    this.playerLight.position.set(0, 4.5, 4);
    this.scene.add(this.playerLight);

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

    this.input.init(this.renderer.domElement);

    const towerGeo = new THREE.CylinderGeometry(0.8, 0.8, 400, 12);
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x6f4a22,
      metalness: 0.8,
      roughness: 0.38,
    });
    this.towerBase = new THREE.Mesh(towerGeo, towerMat);
    this.towerBase.position.y = 190;
    this.scene.add(this.towerBase);

    this.scene.add(this.backgroundGroup);
    this.scene.add(this.particles.group);
    this.scene.add(this.player.mesh);
    this.player.reset(0, 2);

    const shadowGeo = new THREE.CircleGeometry(0.35, 16);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.playerShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.playerShadow.rotation.x = -Math.PI / 2;
    this.playerShadow.visible = false;
    this.scene.add(this.playerShadow);

    const hud = document.getElementById("hud");
    const titleOverlay = document.getElementById("title-overlay");
    const hudScore = document.getElementById("hud-score");
    const hudBest = document.getElementById("hud-best");
    const hudBolts = document.getElementById("hud-bolts");
    const hudStatus = document.getElementById("hud-status");
    const hudToast = document.getElementById("hud-toast");
    const hudControls = document.getElementById("hud-controls");
    const hudCombo = document.getElementById("hud-combo");
    const soundToggleBtn = document.getElementById("sound-toggle");
    const closeCallOverlay = document.getElementById("close-call-overlay");
    const tutorialOverlay = document.getElementById("tutorial-overlay");
    const tutorialControls = document.getElementById("tutorial-controls");
    const tutorialObjective = document.getElementById("tutorial-objective");
    const zoneAnnouncement = document.getElementById("zone-announcement");
    if (!hud || !titleOverlay || !hudScore || !hudBest || !hudBolts || !hudStatus || !hudToast || !hudControls || !hudCombo || !soundToggleBtn || !closeCallOverlay || !tutorialOverlay || !tutorialControls || !tutorialObjective || !zoneAnnouncement) {
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
    this.soundToggleBtn = soundToggleBtn;
    this.closeCallOverlay = closeCallOverlay;
    this.tutorialOverlay = tutorialOverlay;
    this.tutorialControls = tutorialControls;
    this.tutorialObjective = tutorialObjective;
    this.zoneAnnouncement = zoneAnnouncement;

    const heading = this.titleOverlay.querySelector("h1");
    const tagline = this.titleOverlay.querySelector(".tagline");
    const titleBest = document.getElementById("title-best");
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
    this.titlePrompt = prompt as HTMLElement;
    this.gameOverCard = gameOverCard as HTMLElement;
    this.shareScoreBtn = shareScoreBtn as HTMLButtonElement;
    this.gameOverHeightEl = gameOverHeight;
    this.gameOverBoltsEl = gameOverBolts;
    this.gameOverBoltCountEl = gameOverBoltCount;
    this.gameOverComboEl = gameOverCombo;
    this.gameOverTimeEl = gameOverTime;
    this.gameOverTotalEl = gameOverTotal;

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

    this.pauseOverlay.addEventListener("click", (event) => {
      if (!(event.target as HTMLElement).closest("#pause-restart")) {
        this.resumeGame();
      }
    });
    this.pauseOverlay.addEventListener("touchend", (event) => {
      if (!(event.target as HTMLElement).closest("#pause-restart")) {
        event.preventDefault();
        this.resumeGame();
      }
    }, { passive: false });

    const pauseRestartBtn = document.getElementById("pause-restart");
    pauseRestartBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.startGame();
    });

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
      event.preventDefault();
      this.startGame();
    };

    this.titleOverlay.addEventListener("click", handleOverlayActivate);
    this.titleOverlay.addEventListener("touchend", handleOverlayActivate, { passive: false });

    this.resetVisualWorld();
    const { state } = this.sim.reset();
    this.consumeState(state);
    this.syncVisuals(state);
    this.buildBackgroundAtmosphere(this.getMaxGearHeight(state) + 24);
    this.updateHud(dtZero());
    this.updateOverlayText();
    this.input.setTouchControlsVisible(false);

    window.addEventListener("resize", () => this.onResize());

    registerPauseHandlers(
      () => this.pauseAnimationLoop(),
      () => this.resumeAnimationLoop()
    );
    setAudioEnabled(isAudioEnabled());
    onAudioChange((enabled) => setAudioEnabled(enabled));
    await signalLoadComplete();
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
    for (const { mesh } of this.gearShadowMap.values()) {
      this.scene.remove(mesh);
    }
    this.visualGearMap.clear();
    this.visualBoltMap.clear();
    this.visualPowerUpMap.clear();
    this.gears = [];
    this.bolts = [];
    this.gearShadowMap.clear();
    this.gearTickNextTimes.clear();
    this.backgroundGroup.clear();
    this.backgroundDecorations = [];
    this.backgroundGenerationHeight = 0;
    this.particles.reset();
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

    this.updateWorld(dt);
    this.updatePlayerLight(dt);

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private startGame() {
    initAudio();
    playClick();
    this.resumeAnimationLoop();
    this.state = GameState.Playing;
    this.toastTimer = 0;
    this.zoneAnnouncementTimer = 0;
    this.cameraKick = 0;
    this.cameraShakeTimer = 0;
    this.cameraShakeOffset.set(0, 0, 0);
    this.closeCallFlashTimer = 0;
    this.steamSpawnTimer = 0;
    this.deathAnimTimer = 0;
    this.challengeZoneBloomBoost = 0;
    this.inChallengeZone = false;
    this.closeCallOverlay.style.opacity = "0";
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
    this.shareScoreBtn.classList.add("hidden");
    this.titleTagline.classList.remove("new-best");
    this.titleBest.classList.add("hidden");
    this.zoneAnnouncement.style.opacity = "0";
    this.zoneAnnouncement.style.transform = "translate(-50%, 12px)";
    this.input.setTouchControlsVisible(this.input.isTouchDevice());
    this.showTutorialOverlay();
    startAmbientTick();
    startMusic();
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
    setTickRate(this.heightMaxReached);
    setMusicIntensity(this.heightMaxReached);
    this.challengeZoneBloomBoost = Math.max(0, this.challengeZoneBloomBoost - dt * 0.7);
    this.updateEnvironment(state.player.y);
    this.updateWorld(dt);
    this.updateCamera(dt, state);
    this.updatePlayerShadow();
    this.updateHud(dt);

    if (state.gameState === "gameover") {
      this.finishGame(state);
    }
  }

  private finishGame(state: SimState) {
    this.state = GameState.GameOver;
    this.input.setTouchControlsVisible(false);
    this.hideTutorialOverlay(true);
    this.playerShadow.visible = false;
    stopAmbientTick();
    stopMusic();
    this.deathAnimTimer = 0.4;
    this.closeCallFlashTimer = 0;
    this.closeCallOverlay.style.opacity = "0";

    void submitScore(this.score).catch((error: unknown) => {
      console.error("Failed to submit score", error);
    });

    if (this.score > 0) unlockAchievement("FIRST_CLIMB");
    if (this.score >= 500) unlockAchievement("RISING_STAR");
    if (this.score >= 2000) unlockAchievement("GEAR_MASTER");

    const isNewBest = this.score > this.highScore;
    if (isNewBest) {
      this.highScore = this.score;
      localStorage.setItem("gameHighScore", String(this.highScore));
    }

    this.updateHud(dtZero());
    this.titleOverlay.classList.remove("hidden");
    this.titleOverlay.classList.add("game-over");
    this.titleHeading.textContent = "GAME OVER";
    if (isNewBest) {
      this.titleTagline.textContent = `★ NEW BEST ★  SCORE ${this.score} · HEIGHT ${this.heightMaxReached}m`;
      this.titleTagline.classList.add("new-best");
    } else {
      this.titleTagline.textContent = `SCORE ${this.score} · HEIGHT ${this.heightMaxReached}m · BEST ${this.highScore}`;
      this.titleTagline.classList.remove("new-best");
    }
    this.titlePrompt.textContent = this.input.isTouchDevice() ? "TAP TO RESTART" : "PRESS SPACE TO RESTART";

    const gameSeconds = Math.floor(state.gameTime);
    this.gameOverHeightEl.textContent = String(this.heightScore);
    this.gameOverBoltsEl.textContent = String(this.boltScore);
    this.gameOverBoltCountEl.textContent = String(this.boltCount);
    this.gameOverComboEl.textContent = `x${this.bestCombo}`;
    this.gameOverTimeEl.textContent = `${gameSeconds}s`;
    this.gameOverTotalEl.textContent = String(this.score);
    this.gameOverCard.classList.remove("hidden");
    this.shareScoreBtn.classList.remove("hidden");
  }

  private updateGameOver(dt: number) {
    this.updateWorld(dt);
    this.updatePlayerLight(dt);

    if (this.deathAnimTimer > 0) {
      this.deathAnimTimer -= dt;
      this.player.setBodyOpacity(Math.max(0, this.deathAnimTimer / 0.4));
    }

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private consumeState(state: SimState) {
    this.simState = state;
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
  }

  private syncVisuals(state: SimState) {
    let rebuildShadows = false;

    const nextGearIds = new Set(state.gears.map((gear) => gear.id));
    for (const [id, gear] of this.visualGearMap) {
      if (nextGearIds.has(id)) {
        continue;
      }
      this.scene.remove(gear.mesh);
      this.visualGearMap.delete(id);
      this.gearTickNextTimes.delete(id);
      const shadow = this.gearShadowMap.get(gear);
      if (shadow) {
        this.scene.remove(shadow.mesh);
        this.gearShadowMap.delete(gear);
      }
      rebuildShadows = true;
    }

    for (const simGear of state.gears) {
      let gear = this.visualGearMap.get(simGear.id);
      if (!gear) {
        gear = this.createGearVisual(simGear);
        this.visualGearMap.set(simGear.id, gear);
        this.scene.add(gear.mesh);
        rebuildShadows = true;
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
    if (rebuildShadows) {
      this.rebuildGearDropShadows();
    }
    this.ensureBackgroundCoverage(state);
  }

  private createGearVisual(simGear: SimGear): Gear {
    const palette = [0x8c6239, 0xb87333, 0xa67c52, 0x7c5a2c];
    const variantBaseColors: Partial<Record<GearVariant, number>> = {
      wind: 0x4488aa,
      magnetic: 0x8844aa,
      bouncy: 0x44aa44,
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
          this.particles.spawnLandingDust(this.landingEffectPosition);
          this.player.land(event.landingSpeed);
          playLand(event.landingSpeed / 12);
          this.cameraKick = Math.min(this.cameraKick + event.landingSpeed * 0.015, 0.28);
          if (event.nearMiss) {
            this.triggerCloseCallFlash();
          }
          this.triggerLandingShake(event.variant === "crumbling" ? 0.085 : 0.05);
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
          break;
        case "combo_break":
          this.showToast("COMBO LOST");
          break;
        case "milestone":
          this.showToast(`CHECKPOINT ${event.height}m`);
          playMilestone(1 + event.height / 220);
          break;
        case "piston_launch":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          playPistonLaunch();
          this.showToast("PISTON LAUNCH!");
          this.cameraKick = Math.min(this.cameraKick + 0.18, 0.34);
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
          break;
        case "zone_change":
          if (this.state === GameState.Playing) {
            this.showZoneAnnouncement(this.zoneNames[event.zoneIndex] ?? "???");
          }
          break;
        case "achievement":
          unlockAchievement(event.id);
          break;
        case "bounce_jump":
          this.landingEffectPosition.set(event.x, event.y, event.z);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          this.particles.spawnJumpSparks(this.landingEffectPosition);
          playJump(1.45);
          this.cameraKick = Math.max(this.cameraKick, 0.18);
          break;
        case "powerup_collect":
          this.showToast(getPowerUpDisplayName(event.powerUpType));
          playCollect(1.8);
          break;
        case "shield_save":
          this.particles.spawnDeathBurst(this.player.mesh.position);
          this.cameraShakeOffset.set(
            randomRange(-0.14, 0.14),
            randomRange(-0.08, 0.08),
            randomRange(-0.14, 0.14)
          );
          this.cameraShakeTimer = this.cameraShakeDuration;
          this.showToast("SHIELD SAVED YOU!");
          this.triggerCloseCallFlash();
          playHit();
          break;
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

    this.updateGearDropShadows();
    this.updateSteam(dt);
    this.particles.update(dt, this.player.mesh.position);
  }

  private updateCamera(dt: number, state: SimState) {
    const playerX = state.player.x;
    const playerY = state.player.y;
    const playerZ = state.player.z;
    const verticalLead = THREE.MathUtils.clamp(state.player.vy * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (state.player.onGround ? 5.5 : 4));

    const radius = 12 + Math.max(-state.player.vy * 0.08, 0);
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

    const targetFov = THREE.MathUtils.clamp(58 + Math.max(-state.player.vy - 5, 0) * 0.45, 58, 64);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, followLerp);
    this.camera.updateProjectionMatrix();
    this.cameraKick = THREE.MathUtils.lerp(this.cameraKick, 0, 1 - Math.exp(-dt * 7));

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

  private rebuildGearDropShadows() {
    for (const { mesh } of this.gearShadowMap.values()) {
      this.scene.remove(mesh);
    }
    this.gearShadowMap.clear();
    for (const gear of this.gears) {
      this.addDropShadowForGear(gear);
    }
  }

  private addDropShadowForGear(upperGear: Gear) {
    let bestLower: Gear | null = null;
    let bestTopY = -Infinity;

    for (const lowerGear of this.gears) {
      if (lowerGear === upperGear) continue;
      const lowerTopY = lowerGear.getTopY();
      if (lowerTopY >= upperGear.mesh.position.y) continue;

      const dx = upperGear.mesh.position.x - lowerGear.mesh.position.x;
      const dz = upperGear.mesh.position.z - lowerGear.mesh.position.z;
      if (dx * dx + dz * dz > lowerGear.radius * lowerGear.radius) continue;

      if (lowerTopY > bestTopY) {
        bestTopY = lowerTopY;
        bestLower = lowerGear;
      }
    }

    if (bestLower === null) return;

    const verticalDist = upperGear.mesh.position.y - bestLower.getTopY();
    const opacity = THREE.MathUtils.clamp(0.6 - verticalDist * 0.03, 0.1, 0.6);

    const shadowGeo = new THREE.CircleGeometry(upperGear.radius * 0.8, 16);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.set(
      upperGear.mesh.position.x,
      bestLower.getTopY() + 0.02,
      upperGear.mesh.position.z
    );

    this.scene.add(shadowMesh);
    this.gearShadowMap.set(upperGear, { mesh: shadowMesh, lowerGear: bestLower });
  }

  private updateGearDropShadows() {
    for (const [upperGear, { mesh: shadowMesh, lowerGear }] of this.gearShadowMap) {
      const upperActive = getPrivateBoolean(upperGear, "active", true);
      const lowerActive = getPrivateBoolean(lowerGear, "active", true);
      if (!upperActive || !lowerActive) {
        shadowMesh.visible = false;
        continue;
      }
      shadowMesh.visible = true;
      shadowMesh.position.x = upperGear.mesh.position.x;
      shadowMesh.position.z = upperGear.mesh.position.z;
      shadowMesh.position.y = lowerGear.getTopY() + 0.02;
    }
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
    this.titleHeading.textContent = "CLOCKWORK CLIMB";
    this.titleTagline.textContent = "GAMEDEV.JS JAM 2026 — Theme: MACHINES";
    if (this.highScore > 0) {
      this.titleBest.textContent = `YOUR BEST: ${this.highScore}`;
      this.titleBest.classList.remove("hidden");
    } else {
      this.titleBest.textContent = "";
      this.titleBest.classList.add("hidden");
    }
    this.titlePrompt.textContent = this.input.isTouchDevice() ? "TAP TO CLIMB" : "PRESS SPACE OR CLICK TO CLIMB";
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
    this.tutorialFadeTimer = window.setTimeout(() => {
      this.tutorialOverlay.style.opacity = "0";
      this.tutorialHideTimer = window.setTimeout(() => {
        this.tutorialOverlay.classList.add("hidden");
        this.tutorialHideTimer = null;
      }, 500);
      this.tutorialFadeTimer = null;
    }, 3000);
  }

  private hideTutorialOverlay(immediate = false) {
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
    }
  }

  private updateHud(dt: number) {
    this.hudScore.textContent = String(this.score);
    this.hudBest.textContent = String(Math.max(this.highScore, this.score));
    this.hudBolts.textContent = String(this.boltCount);
    this.hudStatus.textContent = `HEIGHT ${this.heightMaxReached}m · NEXT ${this.nextMilestone}m`;

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
  }

  private updateComboHud(multiplier: number) {
    if (multiplier > 1) {
      this.hudCombo.textContent = `COMBO x${multiplier}`;
      this.hudCombo.classList.add("active");
    } else {
      this.hudCombo.textContent = "";
      this.hudCombo.classList.remove("active");
    }
  }

  private showToast(message: string) {
    this.hudToast.textContent = message;
    this.toastTimer = 1.3;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
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
      { height: 0, bg: 0x140d0a, fogDensity: 0.014, ambient: 0xc7aa7a, ambientIntensity: 1.35, bloom: 0.18 },
      { height: 25, bg: 0x0f1318, fogDensity: 0.012, ambient: 0x8899bb, ambientIntensity: 1.5, bloom: 0.22 },
      { height: 50, bg: 0x181b22, fogDensity: 0.010, ambient: 0xb8c4dd, ambientIntensity: 1.7, bloom: 0.26 },
      { height: 75, bg: 0x1a1408, fogDensity: 0.008, ambient: 0xffd6a3, ambientIntensity: 2.0, bloom: 0.32 },
      { height: 100, bg: 0x0a0a14, fogDensity: 0.006, ambient: 0xff88aa, ambientIntensity: 2.4, bloom: 0.40 },
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

  private updatePlayerShadow() {
    let bestY = -Infinity;
    let foundSurface = false;

    for (const gear of this.gears) {
      const active = getPrivateBoolean(gear, "active", true);
      if (!active) continue;
      const dx = this.player.mesh.position.x - gear.mesh.position.x;
      const dz = this.player.mesh.position.z - gear.mesh.position.z;
      const distSq = dx * dx + dz * dz;
      const gearTop = gear.getTopY();

      if (distSq < (gear.radius + 0.3) ** 2 && gearTop <= this.player.mesh.position.y + 0.1 && gearTop > bestY) {
        bestY = gearTop;
        foundSurface = true;
      }
    }

    if (foundSurface) {
      this.playerShadow.visible = true;
      this.playerShadow.position.set(
        this.player.mesh.position.x,
        bestY + 0.02,
        this.player.mesh.position.z
      );
      const distance = Math.max(0, this.player.mesh.position.y - bestY);
      const opacity = THREE.MathUtils.clamp(0.55 - distance * 0.035, 0.1, 0.55);
      const scale = THREE.MathUtils.clamp(1 + distance * 0.04, 0.6, 1.5);
      (this.playerShadow.material as THREE.MeshBasicMaterial).opacity = opacity;
      this.playerShadow.scale.setScalar(scale);
    } else {
      this.playerShadow.visible = false;
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

function getPrivateBoolean(target: object, key: string, fallback: boolean): boolean {
  const value = (target as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

function dtZero(): number {
  return 0;
}

function createPowerUpMesh(type: SimPowerUp["type"]): THREE.Mesh {
  const colorMap: Record<SimPowerUp["type"], number> = {
    bolt_magnet: 0xffcc00,
    slow_mo: 0x4488ff,
    shield: 0xff8844,
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
    case "shield": return "SHIELD ACTIVE!";
  }
}
