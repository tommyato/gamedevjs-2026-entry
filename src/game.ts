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
import { Gear, type GearVariant } from "./gear";
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
  private state = GameState.Title;
  private score = 0;
  private heightScore = 0;
  private heightMaxReached = 0;
  private boltCount = 0;
  private boltScore = 0;
  private highScore = 0;
  private elapsedTime = 0;

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
  private readonly gearTickNextTimes = new Map<Gear, number>();
  private generationHeight = 0;
  private generationAngle = 0;
  private generationCount = 0;
  private cleanupTimer = 0;
  private cameraKick = 0;
  private readonly cameraShakeOffset = new THREE.Vector3();
  private cameraShakeTimer = 0;
  private readonly cameraShakeDuration = 0.15;
  private closeCallFlashTimer = 0;
  private steamSpawnTimer = 0;
  private isDying = false;
  private deathFreezeTimer = 0;
  private deathAnimTimer = 0;
  private activeGear: Gear | null = null;
  private orbitAngle = 0;
  private orbitAngleTarget = Math.PI / 2; // frozen while airborne
  private readonly orbitRadius = 12;
  private gameTime = 0;
  private nextMilestone = 25;
  private toastTimer = 0;
  private zoneAnnouncementTimer = 0;
  private readonly zoneAnnouncementDuration = 2;
  private readonly unlockedThisRun = new Set<string>();
  private currentZoneIndex = 0;
  private readonly zoneNames = [
    "BRONZE DEPTHS",
    "IRON WORKS",
    "SILVER SPIRES",
    "GOLDEN HEIGHTS",
  ] as const;

  // Combo system
  private comboLandings = 0;
  private comboMultiplier = 1;
  private bestCombo = 1;
  private timeSinceLastLanding = Infinity;
  private readonly comboWindow = 2.5;
  private readonly lastComboGears = new WeakSet<Gear>();
  private tutorialShown = false;
  private tutorialFadeTimer: number | null = null;
  private tutorialHideTimer: number | null = null;

  // Environment transitions
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

    // Sound toggle
    const updateSoundBtn = () => {
      this.soundToggleBtn.textContent = getAudioEnabled() ? "🔊" : "🔇";
    };
    updateSoundBtn();
    this.soundToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
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

    // Escape key: pause during Playing, resume during Paused
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.state === GameState.Playing) {
          this.pauseGame();
        } else if (this.state === GameState.Paused) {
          this.resumeGame();
        }
      }
    });

    // Pause overlay: tap/click anywhere to resume (except restart button)
    this.pauseOverlay.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("#pause-restart")) {
        this.resumeGame();
      }
    });
    this.pauseOverlay.addEventListener("touchend", (e) => {
      if (!(e.target as HTMLElement).closest("#pause-restart")) {
        e.preventDefault();
        this.resumeGame();
      }
    }, { passive: false });

    // Restart button inside pause overlay
    const pauseRestartBtn = document.getElementById("pause-restart");
    pauseRestartBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.startGame();
    });

    // Mobile pause button in HUD
    this.pauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
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

    this.resetLevel();
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

  private resetLevel() {
    for (const gear of this.gears) {
      this.scene.remove(gear.mesh);
    }
    for (const bolt of this.bolts) {
      this.scene.remove(bolt.mesh);
    }
    for (const { mesh } of this.gearShadowMap.values()) {
      this.scene.remove(mesh);
    }
    this.gearShadowMap.clear();
    this.backgroundGroup.clear();
    this.backgroundDecorations = [];
    this.gears = [];
    this.bolts = [];
    this.gearTickNextTimes.clear();
    this.particles.reset();
    this.generationHeight = 0;
    this.generationAngle = 0;
    this.generationCount = 0;
    this.cleanupTimer = 0;

    const gearPalette = [0x8c6239, 0xb87333, 0xa67c52, 0x7c5a2c];

    const startGear = new Gear({
      color: 0x8f6b3d,
      danger: 0,
      height: 0.4,
      radius: 2.6,
      rotationSpeed: 0.28,
      variant: "normal",
    });
    startGear.setPosition(0, -0.2, 0);
    this.gears.push(startGear);
    this.scene.add(startGear.mesh);

    let height = 0;
    let angle = Math.random() * Math.PI * 2;
    for (let index = 1; index < 40; index += 1) {
      const band = getDifficultyBand(height);
      height += randomRange(band.verticalMin, band.verticalMax);
      angle += randomRange(0.75, 1.75);

      const radius = randomRange(band.radiusMin, band.radiusMax);
      const distance = randomRange(band.distanceMin, band.distanceMax);
      const color = gearPalette[Math.floor(Math.random() * gearPalette.length)];
      const variant = this.pickGearVariant(height);
      const gear = new Gear({
        color,
        danger: band.danger,
        height: 0.3,
        radius,
        rotationSpeed: randomRange(band.rotationMin, band.rotationMax),
        variant,
      });

      gear.setPosition(Math.cos(angle) * distance, height, Math.sin(angle) * distance);
      this.gears.push(gear);
      this.scene.add(gear.mesh);

      if (variant !== "crumbling" && Math.random() < 0.3) {
        const bolt = new BoltCollectible(gear);
        bolt.reset();
        this.bolts.push(bolt);
        this.scene.add(bolt.mesh);
      }
    }

    this.buildGearDropShadows();
    this.generationHeight = height;
    this.generationAngle = angle;
    this.generationCount = 40;
    this.buildBackgroundAtmosphere(height + 24);
  }

  private buildGearDropShadows() {
    for (const gear of this.gears) {
      this.addDropShadowForGear(gear);
    }
  }

  private addDropShadowForGear(upperGear: Gear) {
    // Find the nearest gear directly below whose XZ footprint overlaps
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
  }

  private generateAhead() {
    const gearPalette = [0x8c6239, 0xb87333, 0xa67c52, 0x7c5a2c];
    let height = this.generationHeight;
    let angle = this.generationAngle;
    let batchesGenerated = 0;

    while (height - this.heightMaxReached <= 40 && batchesGenerated < 5) {
      for (let i = 0; i < 10; i += 1) {
        const band = getDifficultyBand(height);
        height += randomRange(band.verticalMin, band.verticalMax);
        angle += randomRange(0.75, 1.75);

        const radius = randomRange(band.radiusMin, band.radiusMax);
        const distance = randomRange(band.distanceMin, band.distanceMax);
        const color = gearPalette[Math.floor(Math.random() * gearPalette.length)];
        const variant = this.pickGearVariant(height);
        const gear = new Gear({
          color,
          danger: band.danger,
          height: 0.3,
          radius,
          rotationSpeed: randomRange(band.rotationMin, band.rotationMax),
          variant,
        });

        gear.setPosition(Math.cos(angle) * distance, height, Math.sin(angle) * distance);
        this.gears.push(gear);
        this.scene.add(gear.mesh);

        if (variant !== "crumbling" && Math.random() < 0.3) {
          const bolt = new BoltCollectible(gear);
          bolt.reset();
          // Set initial position to avoid stale (0,0,0) during cleanup checks
          bolt.mesh.position.set(gear.mesh.position.x, gear.getTopY() + 0.75, gear.mesh.position.z);
          this.bolts.push(bolt);
          this.scene.add(bolt.mesh);
        }

        this.addDropShadowForGear(gear);
      }

      this.addBackgroundDecorationsAtHeight(height);
      batchesGenerated += 1;
    }

    this.generationHeight = height;
    this.generationAngle = angle;
    this.generationCount += batchesGenerated * 10;
  }

  private cleanupBelow(playerY: number) {
    const cutoffY = playerY - 40;

    const gearsToRemove: Gear[] = [];
    for (const gear of this.gears) {
      if (gear.mesh.position.y < cutoffY) {
        gearsToRemove.push(gear);
      }
    }

    const removedGearSet = new Set(gearsToRemove);
    for (const gear of gearsToRemove) {
      this.scene.remove(gear.mesh);
      const idx = this.gears.indexOf(gear);
      if (idx !== -1) this.gears.splice(idx, 1);
      this.gearTickNextTimes.delete(gear);

      const shadow = this.gearShadowMap.get(gear);
      if (shadow) {
        this.scene.remove(shadow.mesh);
        this.gearShadowMap.delete(gear);
      }
    }

    // For shadows whose lowerGear was removed, recompute against remaining gears
    const orphanedUpperGears: Gear[] = [];
    for (const [upperGear, shadowData] of this.gearShadowMap) {
      if (removedGearSet.has(shadowData.lowerGear)) {
        this.scene.remove(shadowData.mesh);
        this.gearShadowMap.delete(upperGear);
        orphanedUpperGears.push(upperGear);
      }
    }
    for (const upperGear of orphanedUpperGears) {
      this.addDropShadowForGear(upperGear);
    }

    const boltsToRemove = this.bolts.filter((b) => b.mesh.position.y < cutoffY);
    for (const bolt of boltsToRemove) {
      this.scene.remove(bolt.mesh);
      const idx = this.bolts.indexOf(bolt);
      if (idx !== -1) this.bolts.splice(idx, 1);
    }

    const decsToRemove = this.backgroundDecorations.filter((d) => d.mesh.position.y < cutoffY);
    for (const dec of decsToRemove) {
      this.backgroundGroup.remove(dec.mesh);
      const idx = this.backgroundDecorations.indexOf(dec);
      if (idx !== -1) this.backgroundDecorations.splice(idx, 1);
    }
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
    for (let i = 0; i < toothCount; i += 1) {
      const tooth = new THREE.Mesh(toothGeo, toothMaterial);
      const toothAngle = (i / toothCount) * Math.PI * 2;
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

  private pickGearVariant(height: number): GearVariant {
    if (height >= 55 && Math.random() < 0.15) {
      return "piston";
    }
    const roll = Math.random();
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
    this.score = 0;
    this.heightScore = 0;
    this.boltCount = 0;
    this.boltScore = 0;
    this.nextMilestone = 25;
    this.toastTimer = 0;
    this.zoneAnnouncementTimer = 0;
    this.currentZoneIndex = 0;
    this.unlockedThisRun.clear();
    this.cameraKick = 0;
    this.orbitAngle = Math.PI / 2 + 2 * (0.45 / 2.5);
    this.orbitAngleTarget = this.orbitAngle;
    this.isDying = false;
    this.deathFreezeTimer = 0;
    this.deathAnimTimer = 0;
    this.gameTime = 0;
    this.closeCallFlashTimer = 0;
    this.cameraShakeTimer = 0;
    this.cameraShakeOffset.set(0, 0, 0);
    this.steamSpawnTimer = 0;
    this.closeCallOverlay.style.opacity = "0";
    this.comboLandings = 0;
    this.comboMultiplier = 1;
    this.bestCombo = 1;
    this.timeSinceLastLanding = Infinity;
    this.heightMaxReached = 0;
    this.updateComboHud();
    this.player.reset(0, 2);
    this.resetLevel();
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
    // Handle death freeze frame
    if (this.isDying) {
      this.deathFreezeTimer -= dt;
      this.updateWorld(dt);
      this.updateCamera(dt);
      this.updatePlayerLight(dt);
      if (this.deathFreezeTimer <= 0) {
        this.die();
      }
      return;
    }

    // Ensure gears are always generated ahead of the player
    this.generateAhead();

    this.gameTime += dt;
    this.timeSinceLastLanding += dt;
    if (this.comboLandings > 0 && this.timeSinceLastLanding > this.comboWindow) {
      this.breakCombo();
    }
    setTickRate(this.heightMaxReached);
    setMusicIntensity(this.heightMaxReached);
    this.updateEnvironment(this.player.mesh.position.y);
    this.updateWorld(dt);

    let foundGround = false;
    const wasOnGround = this.player.onGround;
    const landingSpeed = Math.max(0, -this.player.velocity.y);

    if (this.player.velocity.y <= 0) {
      for (const gear of this.gears) {
        // Prevent landing on a gear the player jumped through from below
        const gearBottom = gear.mesh.position.y - gear.height / 2;
        if (this.player.prevY < gearBottom - 0.05) continue;

        const result = gear.checkCollision(this.player.mesh.position, 0.3);
        if (!result.onGear) {
          continue;
        }

        this.player.onGround = true;
        this.player.mesh.position.y = result.y;
        this.player.velocity.y = 0;

        if (!wasOnGround) {
          gear.onPlayerLand();
          this.player.land(landingSpeed);
          this.landingEffectPosition.set(this.player.mesh.position.x, result.y + 0.04, this.player.mesh.position.z);
          this.particles.spawnLandingDust(this.landingEffectPosition);
          playLand(landingSpeed / 12);
          this.cameraKick = Math.min(this.cameraKick + landingSpeed * 0.015, 0.28);
          const nearMissDistance = Math.hypot(
            this.player.mesh.position.x - gear.mesh.position.x,
            this.player.mesh.position.z - gear.mesh.position.z
          );
          if (nearMissDistance > gear.radius * 0.7) {
            this.triggerCloseCallFlash();
          }
          this.triggerLandingShake(gear.variant === "crumbling" ? 0.085 : 0.05);
          if (gear.variant === "speed") {
            this.player.giveSpeedBoost(1.55, 0.9);
            this.showToast("SURGE GEAR");
          }
          this.handleComboLanding(gear);
          if (gear.variant === "piston") {
            this.triggerPistonLaunch();
          }
        }

        this.player.mesh.position.addScaledVector(result.momentum, dt);
        this.player.mesh.rotation.y += gear.getAngularVelocity() * dt;
        this.activeGear = gear;
        foundGround = true;
        break;
      }
    }

    if (!foundGround) {
      this.activeGear = null;
    }

    if (this.player.velocity.y > 0) {
      for (const gear of this.gears) {
        const block = gear.checkBlockFromBelow(this.player.mesh.position, 0.6, 0.3);
        if (block.blocked) {
          this.player.mesh.position.y = block.capY;
          this.player.velocity.y = 0;
          break;
        }
      }
    }

    if (!foundGround) {
      this.player.onGround = false;
    }

    const playerFrame = this.player.update(dt, this.input);
    if (playerFrame.jumped) {
      playJump();
      this.particles.spawnJumpSparks(this.player.mesh.position);
      this.cameraKick = Math.max(this.cameraKick, 0.12);
    }

    this.handlePoleCollision();
    this.handleBoltCollection();
    this.updateCamera(dt);
    this.updatePlayerShadow();
    this.updateScores();
    this.updateHud(dt);
    this.checkMilestoneAchievements();

    // Periodically remove gears/bolts/decorations far below the player
    this.cleanupTimer += dt;
    if (this.cleanupTimer >= 2) {
      this.cleanupTimer = 0;
      this.cleanupBelow(this.player.mesh.position.y);
    }

    if (this.player.mesh.position.y < this.camera.position.y - 12) {
      this.startDeath();
    }
  }

  private startDeath() {
    this.isDying = true;
    this.deathFreezeTimer = 0.2;
    if (this.comboMultiplier > 1) {
      this.breakCombo();
    } else {
      this.comboLandings = 0;
      this.comboMultiplier = 1;
      this.updateComboHud();
    }
    this.cameraShakeOffset.set(
      randomRange(-0.08, 0.08),
      randomRange(-0.05, 0.05),
      randomRange(-0.08, 0.08)
    );
    this.cameraShakeTimer = this.cameraShakeDuration;
    this.particles.spawnDeathBurst(this.player.mesh.position);
    this.player.setDyingVisual();
    playHit();
  }

  private updateWorld(dt: number) {
    for (const gear of this.gears) {
      gear.update(dt);
      const nearCamera = Math.abs(gear.getTopY() - this.camera.position.y) < 18;
      if (nearCamera && gear.isSolid() && Math.random() < dt * 0.45) {
        this.particles.spawnGearSpark(gear);
      }

      if (this.state === GameState.Playing && gear.isSolid()) {
        const gearPosition = gear.getPosition(this.landingEffectPosition);
        const distance = gearPosition.distanceTo(this.player.mesh.position);
        if (distance <= 15) {
          const angularSpeed = Math.abs(gear.getAngularVelocity());
          if (angularSpeed < 0.05) {
            this.gearTickNextTimes.delete(gear);
            continue;
          }
          const teethInterval = (Math.PI * 2) / Math.max(angularSpeed * Math.max(6, Math.floor(gear.radius * 10)), 0.001);
          const interval = THREE.MathUtils.clamp(teethInterval, 0.25, 1.25);
          const nextTickAt = this.gearTickNextTimes.get(gear) ?? this.elapsedTime + interval;
          if (this.elapsedTime >= nextTickAt) {
            playGearTick(distance, angularSpeed);
            this.gearTickNextTimes.set(gear, this.elapsedTime + interval);
          } else if (!this.gearTickNextTimes.has(gear)) {
            this.gearTickNextTimes.set(gear, nextTickAt);
          }
        } else {
          this.gearTickNextTimes.delete(gear);
        }
      }
    }

    for (const bolt of this.bolts) {
      bolt.update(dt, this.elapsedTime);
    }

    for (const decoration of this.backgroundDecorations) {
      decoration.mesh.rotation.z += decoration.rotationSpeed * dt;
    }

    this.updateGearDropShadows();
    this.updateSteam(dt);
    this.particles.update(dt, this.player.mesh.position);
  }

  private updateGearDropShadows() {
    for (const [upperGear, { mesh: shadowMesh, lowerGear }] of this.gearShadowMap) {
      if (!upperGear.isSolid() || !lowerGear.isSolid()) {
        shadowMesh.visible = false;
        continue;
      }
      shadowMesh.visible = true;
      if (upperGear.variant === "piston") {
        // Update Y in case the gear surface moves
        shadowMesh.position.y = lowerGear.getTopY() + 0.02;
      }
    }
  }

  private handlePoleCollision() {
    const distFromCenter = Math.hypot(this.player.mesh.position.x, this.player.mesh.position.z);
    const minRadius = 0.8 + 0.3;
    if (distFromCenter < minRadius && distFromCenter > 0.001) {
      const pushOut = minRadius / distFromCenter;
      this.player.mesh.position.x *= pushOut;
      this.player.mesh.position.z *= pushOut;
    }
  }

  private handleBoltCollection() {
    for (const bolt of this.bolts) {
      if (!bolt.tryCollect(this.player.mesh.position)) {
        continue;
      }

      this.boltCount += 1;
      this.boltScore += 5;
      playCollect(1 + this.boltCount * 0.02);
      this.showToast(`BOLT +5 · ${this.boltCount} COLLECTED`);
    }
  }

  private updateCamera(dt: number) {
    const playerX = this.player.mesh.position.x;
    const playerY = this.player.mesh.position.y;
    const playerZ = this.player.mesh.position.z;

    const verticalLead = THREE.MathUtils.clamp(this.player.velocity.y * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (this.player.onGround ? 5.5 : 4));
    const orbitLerp = 1 - Math.exp(-dt * 5);

    // Only recompute orbit target when grounded — camera holds steady during jumps
    // so the player can judge trajectories without the world rotating under them.
    if (this.player.onGround) {
      // Base angle — counterclockwise (increasing) with height. Baseline orientation
      // at height 0 points the camera down +Z looking toward the origin, matching the
      // previous camera's framing. We rotate counterclockwise as the player climbs.
      const radiansPerUnit = 0.45 / 2.5; // ~0.45 rad per ~2.5m of height
      const baseAngle = Math.PI / 2 + playerY * radiansPerUnit;

      // Gear-avoidance nudge — if any nearby gear sits between the camera and the
      // player (in XZ projection), push the target angle further counterclockwise.
      let nudge = 0;
      const maxNudge = 0.3;
      const nudgeStep = 0.05;
      const angleTolerance = 0.18; // ~10° — how close a gear must be to the cam→player line to count as occluding
      const verticalWindow = 3;

      // Iteratively search for a clear angle, up to maxNudge
      for (let step = 0; step <= maxNudge / nudgeStep; step += 1) {
        const testAngle = baseAngle + nudge;
        const camX = Math.cos(testAngle) * this.orbitRadius;
        const camZ = Math.sin(testAngle) * this.orbitRadius;
        const toPlayerX = playerX - camX;
        const toPlayerZ = playerZ - camZ;
        const toPlayerLen = Math.hypot(toPlayerX, toPlayerZ) || 1;
        const camToPlayerAngle = Math.atan2(toPlayerZ, toPlayerX);

        let clear = true;
        for (const gear of this.gears) {
          if (gear === this.activeGear) continue;
          const gy = gear.mesh.position.y;
          if (Math.abs(gy - playerY) > verticalWindow) continue;
          const gx = gear.mesh.position.x;
          const gz = gear.mesh.position.z;
          const toGearX = gx - camX;
          const toGearZ = gz - camZ;
          const toGearLen = Math.hypot(toGearX, toGearZ) || 1;
          // Gear must be between camera and player (closer to camera than player is)
          if (toGearLen >= toPlayerLen) continue;
          const camToGearAngle = Math.atan2(toGearZ, toGearX);
          let angleDelta = camToGearAngle - camToPlayerAngle;
          while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
          while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
          // Widen the tolerance by the gear's angular half-width as seen from camera
          const gearAngularHalf = Math.atan2(gear.radius, toGearLen);
          if (Math.abs(angleDelta) < angleTolerance + gearAngularHalf) {
            clear = false;
            break;
          }
        }

        if (clear) break;
        nudge = Math.min(nudge + nudgeStep, maxNudge);
      }

      this.orbitAngleTarget = baseAngle + nudge;
    }

    const targetAngle = this.orbitAngleTarget;

    // Smoothly interpolate orbit angle toward target, handling wrap-around
    let angleDiff = targetAngle - this.orbitAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    this.orbitAngle += angleDiff * orbitLerp;

    // Fallback zoom — pull camera back when falling fast
    const radius = this.orbitRadius + Math.max(-this.player.velocity.y * 0.08, 0);

    const targetCamX = Math.cos(this.orbitAngle) * radius;
    const targetCamZ = Math.sin(this.orbitAngle) * radius;
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

    const targetFov = THREE.MathUtils.clamp(58 + Math.max(-this.player.velocity.y - 5, 0) * 0.45, 58, 64);
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

  private updateScores() {
    const currentHeight = Math.max(0, Math.floor(this.player.mesh.position.y));
    const previousReached = this.heightMaxReached;
    if (currentHeight > this.heightMaxReached) {
      const delta = currentHeight - this.heightMaxReached;
      this.heightMaxReached = currentHeight;
      this.heightScore += delta * this.comboMultiplier;
    }
    this.score = this.heightScore + this.boltScore;

    if (this.heightMaxReached > previousReached && this.heightMaxReached >= this.nextMilestone) {
      while (this.heightMaxReached >= this.nextMilestone) {
        this.showToast(`CHECKPOINT ${this.nextMilestone}m`);
        playMilestone(1 + this.nextMilestone / 220);
        this.nextMilestone += 25;
      }
    }
  }

  private checkMilestoneAchievements() {
    const unlock = (id: string) => {
      if (!this.unlockedThisRun.has(id)) {
        this.unlockedThisRun.add(id);
        unlockAchievement(id);
      }
    };
    if (this.heightMaxReached >= 50) unlock('SKY_HIGH');
    if (this.heightMaxReached >= 100) unlock('CLOUD_WALKER');
    if (this.boltCount >= 10) unlock('BOLT_COLLECTOR');
    if (this.boltCount >= 25) unlock('BOLT_HOARDER');
    if (this.gameTime >= 60) unlock('ENDURANCE');
  }

  private die() {
    this.isDying = false;
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

    if (this.score > 0) unlockAchievement('FIRST_CLIMB');
    if (this.score >= 500) unlockAchievement('RISING_STAR');
    if (this.score >= 2000) unlockAchievement('GEAR_MASTER');

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

    const gameSeconds = Math.floor(this.gameTime);
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

  private showToast(message: string) {
    this.hudToast.textContent = message;
    this.toastTimer = 1.3;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
  }

  private showZoneAnnouncement(zoneIndex: number) {
    this.zoneAnnouncement.textContent = this.zoneNames[zoneIndex];
    this.zoneAnnouncementTimer = this.zoneAnnouncementDuration;
    this.zoneAnnouncement.style.opacity = "1";
    this.zoneAnnouncement.style.transform = "translate(-50%, 0)";
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
      if (!gear.isSolid()) continue;
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
      this.steamSpawnTimer += randomRange(0.5, 1.0);
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

  private handleComboLanding(gear: Gear) {
    // Only count combo if this is a different gear from last landing (chaining),
    // and within the combo window.
    const withinWindow = this.timeSinceLastLanding <= this.comboWindow;
    const sameGear = this.lastComboGears.has(gear);

    let progressed = false;
    if (!sameGear) {
      if (withinWindow || this.comboLandings === 0) {
        this.comboLandings += 1;
      } else {
        // Window expired: reset to start this as first landing of a new combo
        this.comboLandings = 1;
      }
      progressed = true;
    }

    // Track most recent gear so re-bounces on same gear don't inflate combo
    this.lastComboGears.add(gear);

    this.timeSinceLastLanding = 0;
    const newMultiplier = comboLandingsToMultiplier(this.comboLandings);

    if (newMultiplier > 1 && newMultiplier !== this.comboMultiplier) {
      this.showToast(`COMBO x${newMultiplier}!`);
    }
    this.comboMultiplier = newMultiplier;
    this.bestCombo = Math.max(this.bestCombo, this.comboMultiplier);

    if (progressed && this.comboMultiplier > 1) {
      playComboLand(this.comboMultiplier);
    }

    this.updateComboHud();
  }

  private breakCombo() {
    if (this.comboMultiplier > 1) {
      this.showToast("COMBO LOST");
    }
    this.comboLandings = 0;
    this.comboMultiplier = 1;
    this.timeSinceLastLanding = Infinity;
    this.updateComboHud();
  }

  private updateComboHud() {
    if (this.comboMultiplier > 1) {
      this.hudCombo.textContent = `COMBO x${this.comboMultiplier}`;
      this.hudCombo.classList.add("active");
    } else {
      this.hudCombo.textContent = "";
      this.hudCombo.classList.remove("active");
    }
  }

  private triggerPistonLaunch() {
    this.player.velocity.y = 18;
    this.player.onGround = false;
    this.particles.spawnJumpSparks(this.player.mesh.position);
    this.particles.spawnJumpSparks(this.player.mesh.position);
    this.particles.spawnJumpSparks(this.player.mesh.position);
    playPistonLaunch();
    this.showToast("PISTON LAUNCH!");
    this.cameraKick = Math.min(this.cameraKick + 0.18, 0.34);
  }

  private updateEnvironment(height: number) {
    // Zone waypoints — (heightAtZoneCenter, bg, fogDensity, ambientHex, ambientIntensity, bloomStrength)
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
    ];
    const zoneIndex = zones.reduce((index, zone, candidateIndex) => (
      height >= zone.height ? candidateIndex : index
    ), 0);

    if (this.state === GameState.Playing && zoneIndex > this.currentZoneIndex) {
      this.showZoneAnnouncement(zoneIndex);
    }
    this.currentZoneIndex = zoneIndex;

    // Find the two zones to interpolate between, with a ~5m transition band.
    let from = zones[0];
    let to = zones[0];
    let t = 0;
    for (let i = 0; i < zones.length - 1; i += 1) {
      const a = zones[i];
      const b = zones[i + 1];
      if (height <= a.height) {
        from = a;
        to = a;
        t = 0;
        break;
      }
      // Transition band is [b.height - 5, b.height]
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
      if (i === zones.length - 2) {
        from = b;
        to = b;
        t = 0;
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

    this.bloomPass.strength = THREE.MathUtils.lerp(from.bloom, to.bloom, t);
  }
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

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function dtZero(): number {
  return 0;
}
