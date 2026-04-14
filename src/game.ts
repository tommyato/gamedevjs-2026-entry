import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { initAudio, playClick, playHit, playJump, playLand, playMilestone, setAudioEnabled } from "./audio";
import { Input } from "./input";
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
import { Gear } from "./gear";

enum GameState {
  Title,
  Playing,
  GameOver,
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

  private input = new Input();
  private state = GameState.Title;
  private score = 0;
  private highScore = 0;

  private hud!: HTMLElement;
  private titleOverlay!: HTMLElement;
  private hudScore!: HTMLElement;
  private hudBest!: HTMLElement;
  private hudStatus!: HTMLElement;
  private hudToast!: HTMLElement;
  private titleHeading!: HTMLElement;
  private titleTagline!: HTMLElement;
  private titlePrompt!: HTMLElement;

  private player = new Player();
  private gears: Gear[] = [];
  private towerBase!: THREE.Mesh;
  private playerLight!: THREE.PointLight;
  private readonly cameraLookTarget = new THREE.Vector3();
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

    const container = document.getElementById("game-container")!;
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

    this.playerLight = new THREE.PointLight(0xffc06a, 26, 16, 2);
    this.playerLight.position.set(0, 4.5, 4);
    this.scene.add(this.playerLight);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.45, 0.4, 0.82
    );
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.bloomPass);

    this.input.init(this.renderer.domElement);

    // Tower central pillar
    const towerGeo = new THREE.CylinderGeometry(0.8, 0.8, 400, 12);
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x6f4a22,
      metalness: 0.8,
      roughness: 0.38
    });
    this.towerBase = new THREE.Mesh(towerGeo, towerMat);
    this.towerBase.position.y = 190;
    this.towerBase.castShadow = true;
    this.towerBase.receiveShadow = true;
    this.scene.add(this.towerBase);

    // Initial gears
    this.resetLevel();

    this.scene.add(this.player.mesh);
    this.player.reset(0, 2);

    this.hud = document.getElementById("hud")!;
    this.titleOverlay = document.getElementById("title-overlay")!;
    this.hudScore = document.getElementById("hud-score")!;
    this.hudBest = document.getElementById("hud-best")!;
    this.hudStatus = document.getElementById("hud-status")!;
    this.hudToast = document.getElementById("hud-toast")!;
    this.titleHeading = this.titleOverlay.querySelector("h1")!;
    this.titleTagline = this.titleOverlay.querySelector(".tagline")!;
    this.titlePrompt = this.titleOverlay.querySelector(".prompt")!;

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
    this.gears.forEach(g => this.scene.remove(g.mesh));
    this.gears = [];

    const gearPalette = [0x8c6239, 0xb87333, 0xa67c52, 0x7c5a2c];

    // Starting platform
    const startGear = new Gear(2.5, 0.4, 0, 0x8f6b3d);
    startGear.mesh.position.set(0, -0.2, 0);
    this.gears.push(startGear);
    this.scene.add(startGear.mesh);

    // Random gears ascending
    for (let i = 1; i < 40; i++) {
      const radius = 1.2 + Math.random() * 1.5;
      const angle = Math.random() * Math.PI * 2;
      const dist = 1.5 + Math.random() * 2.0;
      const color = gearPalette[Math.floor(Math.random() * gearPalette.length)];
      const gear = new Gear(radius, 0.3, 0.3 + Math.random() * 0.7, color);
      gear.mesh.position.set(Math.cos(angle) * dist, i * 2.5, Math.sin(angle) * dist);
      this.gears.push(gear);
      this.scene.add(gear.mesh);
    }
  }

  private loop() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
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

    this.gears.forEach(g => g.update(dt));
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
    this.nextMilestone = 25;
    this.toastTimer = 0;
    this.cameraKick = 0;
    this.player.reset(0, 2);
    this.resetLevel();
    this.updateHud(dtZero());
    this.titleHeading.textContent = "CLOCKWORK CLIMB";
    this.titleTagline.textContent = "GAMEDEV.JS JAM 2026 — Theme: MACHINES";
    this.titlePrompt.textContent = "PRESS SPACE OR CLICK TO CLIMB";
    this.hud.classList.remove("hidden");
    this.titleOverlay.classList.add("hidden");
  }

  private updatePlaying(dt: number) {
    this.gears.forEach(g => g.update(dt));

    // Player ground check
    let foundGround = false;
    const wasOnGround = this.player.onGround;
    const landingSpeed = Math.max(0, -this.player.velocity.y);
    if (this.player.velocity.y <= 0) {
      for (const gear of this.gears) {
        const result = gear.checkCollision(this.player.mesh.position, 0.3);
        if (result.onGear) {
          this.player.onGround = true;
          this.player.mesh.position.y = result.y;
          this.player.velocity.y = 0;
          if (!wasOnGround) {
            this.player.land(landingSpeed);
            playLand(landingSpeed / 12);
            this.cameraKick = Math.min(this.cameraKick + landingSpeed * 0.015, 0.28);
          }

          // Inherit momentum and match the gear's rotation direction visually.
          this.player.mesh.position.addScaledVector(result.momentum, dt);
          this.player.mesh.rotation.y += gear.rotationSpeed * gear.rotationDir * dt;
          foundGround = true;
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
      this.cameraKick = Math.max(this.cameraKick, 0.12);
    }

    // Pole collision
    const distFromCenter = Math.hypot(this.player.mesh.position.x, this.player.mesh.position.z);
    const minRadius = 0.8 + 0.3; // pole radius + player radius
    if (distFromCenter < minRadius && distFromCenter > 0.001) {
      const pushOut = minRadius / distFromCenter;
      this.player.mesh.position.x *= pushOut;
      this.player.mesh.position.z *= pushOut;
    }

    // Camera follow
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

    // Score based on height
    const previousScore = this.score;
    this.score = Math.max(this.score, Math.floor(this.player.mesh.position.y));
    if (this.score > previousScore && this.score >= this.nextMilestone) {
      while (this.score >= this.nextMilestone) {
        this.showToast(`CHECKPOINT ${this.nextMilestone}m`);
        playMilestone(1 + this.nextMilestone / 220);
        this.nextMilestone += 25;
      }
    }
    this.updateHud(dt);

    // Death check
    if (this.player.mesh.position.y < this.camera.position.y - 12) {
      this.die();
    }
  }

  private die() {
    this.state = GameState.GameOver;
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
    this.titleTagline.textContent = `FINAL HEIGHT ${this.score}m · BEST ${this.highScore}m`;
    this.titlePrompt.textContent = "PRESS SPACE TO RESTART";
  }

  private updateGameOver(dt: number) {
    this.updatePlayerLight(dt);

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
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
    this.hudStatus.textContent = `NEXT ${this.nextMilestone}m`;

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

function dtZero(): number {
  return 0;
}
