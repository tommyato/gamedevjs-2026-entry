import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { initAudio, playClick, setAudioEnabled } from "./audio";
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

  private player = new Player();
  private gears: Gear[] = [];
  private towerBase!: THREE.Mesh;

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
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x120b08);
    this.scene.fog = new THREE.FogExp2(0x120b08, 0.018);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 6.5, 12);
    this.camera.lookAt(0, 2, 0);

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

    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.05, 0.55, 0.72
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
    this.camera.position.set(Math.sin(t) * 10, 5, Math.cos(t) * 10);
    this.camera.lookAt(0, 2, 0);

    this.gears.forEach(g => g.update(dt));

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private startGame() {
    initAudio();
    playClick();
    this.state = GameState.Playing;
    this.score = 0;
    this.player.reset(0, 2);
    this.resetLevel();
    this.hud.classList.remove("hidden");
    this.titleOverlay.classList.add("hidden");
  }

  private updatePlaying(dt: number) {
    this.gears.forEach(g => g.update(dt));

    // Player ground check
    let foundGround = false;
    if (this.player.velocity.y <= 0) {
        for (const gear of this.gears) {
            const result = gear.checkCollision(this.player.mesh.position, 0.3);
            if (result.onGear) {
                this.player.onGround = true;
                this.player.mesh.position.y = result.y;
                this.player.velocity.y = 0;
                // Inherit momentum
                this.player.mesh.position.addScaledVector(result.momentum, dt);
                foundGround = true;
                break;
            }
        }
    }
    if (!foundGround) {
        this.player.onGround = false;
    }

    this.player.update(dt, this.input);

    // Pole collision
    const distFromCenter = Math.hypot(this.player.mesh.position.x, this.player.mesh.position.z);
    const minRadius = 0.8 + 0.3; // pole radius + player radius
    if (distFromCenter < minRadius && distFromCenter > 0.001) {
        const pushOut = minRadius / distFromCenter;
        this.player.mesh.position.x *= pushOut;
        this.player.mesh.position.z *= pushOut;
    }

    // Camera follow
    const targetCamY = this.player.mesh.position.y + 5;
    this.camera.position.y += (targetCamY - this.camera.position.y) * dt * 2;
    this.camera.position.x += (this.player.mesh.position.x * 0.5 - this.camera.position.x) * dt;
    this.camera.position.z += (this.player.mesh.position.z + 10 - this.camera.position.z) * dt;
    this.camera.lookAt(this.player.mesh.position.x, this.player.mesh.position.y + 1, this.player.mesh.position.z);

    // Score based on height
    this.score = Math.max(this.score, Math.floor(this.player.mesh.position.y));
    this.hudScore.textContent = String(this.score);

    // Death check
    if (this.player.mesh.position.y < this.camera.position.y - 12) {
        this.die();
    }
  }

  private die() {
    this.state = GameState.GameOver;
    void submitScore(this.score).catch((error: unknown) => {
      console.error("Failed to submit score", error);
    });

    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem("gameHighScore", String(this.highScore));
    }
    
    this.titleOverlay.classList.remove("hidden");
    const titleText = this.titleOverlay.querySelector("h1");
    if (titleText) titleText.textContent = "GAME OVER";
    const promptText = this.titleOverlay.querySelector(".prompt");
    if (promptText) promptText.textContent = "PRESS SPACE TO RESTART";
  }

  private updateGameOver(dt: number) {
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
}
