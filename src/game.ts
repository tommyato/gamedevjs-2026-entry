import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  initAudio,
  playClick,
  playCollect,
  playHit,
  playJump,
  playLand,
  playMilestone,
  setAudioEnabled,
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
} from "./platform";
import { Player } from "./player";

enum GameState {
  Title,
  Playing,
  GameOver,
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
  private titleHeading!: HTMLElement;
  private titleTagline!: HTMLElement;
  private titlePrompt!: HTMLElement;

  private readonly player = new Player();
  private gears: Gear[] = [];
  private bolts: BoltCollectible[] = [];
  private towerBase!: THREE.Mesh;
  private playerLight!: THREE.PointLight;
  private readonly cameraLookTarget = new THREE.Vector3();
  private readonly landingEffectPosition = new THREE.Vector3();
  private readonly particles = new ParticleSystem(100);
  private readonly backgroundGroup = new THREE.Group();
  private backgroundDecorations: BackgroundDecoration[] = [];
  private cameraKick = 0;
  private nextMilestone = 25;
  private toastTimer = 0;

  async start() {
    this.init();
    this.resumeAnimationLoop();
    signalGameReady();
  }

  private init() {
    platformInit();
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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x140d0a);
    this.scene.fog = new THREE.FogExp2(0x140d0a, 0.014);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 6.8, 11.2);
    this.camera.lookAt(0, 4, 0);

    const ambient = new THREE.AmbientLight(0xc7aa7a, 1.35);
    this.scene.add(ambient);

    const hemisphere = new THREE.HemisphereLight(0xf2dcc2, 0x2b1a10, 1.1);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight(0xffd6a3, 2.8);
    keyLight.position.set(8, 18, 10);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 80;
    keyLight.shadow.camera.left = -16;
    keyLight.shadow.camera.right = 16;
    keyLight.shadow.camera.top = 16;
    keyLight.shadow.camera.bottom = -16;
    keyLight.shadow.bias = -0.0008;
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
    this.towerBase.castShadow = true;
    this.towerBase.receiveShadow = true;
    this.scene.add(this.towerBase);
    this.scene.add(this.backgroundGroup);
    this.scene.add(this.particles.group);

    this.scene.add(this.player.mesh);
    this.player.reset(0, 2);

    const hud = document.getElementById("hud");
    const titleOverlay = document.getElementById("title-overlay");
    const hudScore = document.getElementById("hud-score");
    const hudBest = document.getElementById("hud-best");
    const hudBolts = document.getElementById("hud-bolts");
    const hudStatus = document.getElementById("hud-status");
    const hudToast = document.getElementById("hud-toast");
    const hudControls = document.getElementById("hud-controls");
    if (!hud || !titleOverlay || !hudScore || !hudBest || !hudBolts || !hudStatus || !hudToast || !hudControls) {
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

    const heading = this.titleOverlay.querySelector("h1");
    const tagline = this.titleOverlay.querySelector(".tagline");
    const prompt = this.titleOverlay.querySelector(".prompt");
    if (!heading || !tagline || !prompt) {
      throw new Error("Missing title overlay elements");
    }

    this.titleHeading = heading as HTMLElement;
    this.titleTagline = tagline as HTMLElement;
    this.titlePrompt = prompt as HTMLElement;

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
    signalLoadComplete();
  }

  private resetLevel() {
    for (const gear of this.gears) {
      this.scene.remove(gear.mesh);
    }
    for (const bolt of this.bolts) {
      this.scene.remove(bolt.mesh);
    }
    this.backgroundGroup.clear();
    this.backgroundDecorations = [];
    this.gears = [];
    this.bolts = [];
    this.particles.reset();

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
    for (let index = 1; index < 64; index += 1) {
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

    this.buildBackgroundAtmosphere(height + 24);
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

  private pickGearVariant(height: number): GearVariant {
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
    this.state = GameState.Playing;
    this.score = 0;
    this.heightScore = 0;
    this.boltCount = 0;
    this.boltScore = 0;
    this.nextMilestone = 25;
    this.toastTimer = 0;
    this.cameraKick = 0;
    this.player.reset(0, 2);
    this.resetLevel();
    this.updateHud(dtZero());
    this.hud.classList.remove("hidden");
    this.titleOverlay.classList.add("hidden");
    this.input.setTouchControlsVisible(this.input.isTouchDevice());
  }

  private updatePlaying(dt: number) {
    this.updateWorld(dt);

    let foundGround = false;
    const wasOnGround = this.player.onGround;
    const landingSpeed = Math.max(0, -this.player.velocity.y);

    if (this.player.velocity.y <= 0) {
      for (const gear of this.gears) {
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
          if (gear.variant === "speed") {
            this.player.giveSpeedBoost(1.55, 0.9);
            this.showToast("SURGE GEAR");
          }
        }

        this.player.mesh.position.addScaledVector(result.momentum, dt);
        this.player.mesh.rotation.y += gear.getAngularVelocity() * dt;
        foundGround = true;
        break;
      }
    }

    if (!foundGround) {
      this.player.onGround = false;
    }

    const playerFrame = this.player.update(dt, this.input);
    if (playerFrame.jumped) {
      playJump();
      this.cameraKick = Math.max(this.cameraKick, 0.12);
    }

    this.handlePoleCollision();
    this.handleBoltCollection();
    this.updateCamera(dt);
    this.updateScores();
    this.updateHud(dt);

    if (this.player.mesh.position.y < this.camera.position.y - 12) {
      this.die();
    }
  }

  private updateWorld(dt: number) {
    for (const gear of this.gears) {
      gear.update(dt);
      const nearCamera = Math.abs(gear.getTopY() - this.camera.position.y) < 18;
      if (nearCamera && gear.isSolid() && Math.random() < dt * 0.45) {
        this.particles.spawnGearSpark(gear);
      }
    }

    for (const bolt of this.bolts) {
      bolt.update(dt, this.elapsedTime);
    }

    for (const decoration of this.backgroundDecorations) {
      decoration.mesh.rotation.z += decoration.rotationSpeed * dt;
    }

    this.particles.update(dt, this.player.mesh.position);
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
    const verticalLead = THREE.MathUtils.clamp(this.player.velocity.y * 0.12, -1.2, 1.6);
    const followLerp = 1 - Math.exp(-dt * (this.player.onGround ? 5.5 : 4));
    const targetCamX = this.player.mesh.position.x * 0.42;
    const targetCamY = this.player.mesh.position.y + 6.1 + verticalLead + this.cameraKick;
    const targetCamZ = this.player.mesh.position.z + 10.2 + Math.max(-this.player.velocity.y * 0.08, 0);
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, targetCamX, followLerp);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, targetCamY, followLerp);
    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, targetCamZ, followLerp);
    this.cameraLookTarget.set(
      this.player.mesh.position.x * 0.2,
      this.player.mesh.position.y + 1.3 + verticalLead * 0.35,
      this.player.mesh.position.z - 0.6
    );
    this.camera.lookAt(this.cameraLookTarget);
    const targetFov = THREE.MathUtils.clamp(58 + Math.max(-this.player.velocity.y - 5, 0) * 0.45, 58, 64);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, followLerp);
    this.camera.updateProjectionMatrix();
    this.cameraKick = THREE.MathUtils.lerp(this.cameraKick, 0, 1 - Math.exp(-dt * 7));
    this.updatePlayerLight(dt);
  }

  private updateScores() {
    const previousHeight = this.heightScore;
    this.heightScore = Math.max(this.heightScore, Math.floor(this.player.mesh.position.y));
    this.score = this.heightScore + this.boltScore;

    if (this.heightScore > previousHeight && this.heightScore >= this.nextMilestone) {
      while (this.heightScore >= this.nextMilestone) {
        this.showToast(`CHECKPOINT ${this.nextMilestone}m`);
        playMilestone(1 + this.nextMilestone / 220);
        this.nextMilestone += 25;
      }
    }
  }

  private die() {
    this.state = GameState.GameOver;
    this.input.setTouchControlsVisible(false);
    playHit();
    void submitScore(this.score).catch((error: unknown) => {
      console.error("Failed to submit score", error);
    });

    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem("gameHighScore", String(this.highScore));
    }

    this.updateHud(dtZero());
    this.titleOverlay.classList.remove("hidden");
    this.titleHeading.textContent = "GAME OVER";
    this.titleTagline.textContent = `SCORE ${this.score} · HEIGHT ${this.heightScore}m · BEST ${this.highScore}`;
    this.titlePrompt.textContent = this.input.isTouchDevice() ? "TAP TO RESTART" : "PRESS SPACE TO RESTART";
  }

  private updateGameOver(dt: number) {
    this.updateWorld(dt);
    this.updatePlayerLight(dt);

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private updateOverlayText() {
    this.titleHeading.textContent = "CLOCKWORK CLIMB";
    this.titleTagline.textContent = "GAMEDEV.JS JAM 2026 — Theme: MACHINES";
    this.titlePrompt.textContent = this.input.isTouchDevice() ? "TAP TO CLIMB" : "PRESS SPACE OR CLICK TO CLIMB";
    this.hudControls.textContent = this.input.isTouchDevice()
      ? "LEFT JOYSTICK TO MOVE · JUMP TO LEAP"
      : "WASD / ARROWS TO MOVE · SPACE OR TAP TO JUMP";
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
    this.hudStatus.textContent = `HEIGHT ${this.heightScore}m · NEXT ${this.nextMilestone}m`;

    this.toastTimer = Math.max(0, this.toastTimer - dt);
    const toastVisible = this.toastTimer > 0;
    const visibility = Math.min(this.toastTimer / 0.9, 1);
    this.hudToast.style.opacity = toastVisible ? String(visibility) : "0";
    this.hudToast.style.transform = `translate(-50%, ${toastVisible ? (1 - visibility) * 10 : 12}px)`;
  }

  private showToast(message: string) {
    this.hudToast.textContent = message;
    this.toastTimer = 1.3;
    this.hudToast.style.opacity = "1";
    this.hudToast.style.transform = "translate(-50%, 0)";
  }

  private updatePlayerLight(dt: number) {
    const lightLerp = 1 - Math.exp(-dt * 5);
    this.playerLight.position.x = THREE.MathUtils.lerp(this.playerLight.position.x, this.player.mesh.position.x, lightLerp);
    this.playerLight.position.y = THREE.MathUtils.lerp(this.playerLight.position.y, this.player.mesh.position.y + 3.2, lightLerp);
    this.playerLight.position.z = THREE.MathUtils.lerp(this.playerLight.position.z, this.player.mesh.position.z + 2.6, lightLerp);
  }
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
