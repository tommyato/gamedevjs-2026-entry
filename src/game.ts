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

/**
 * Game skeleton — Three.js scene with bloom, state machine, responsive resize.
 * Replace the placeholder content once theme is known.
 */

enum GameState {
  Title,
  Playing,
  GameOver,
}

export class Game {
  // Three.js core
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private clock = new THREE.Clock();
  private readonly animationLoop = () => this.loop();
  private animationLoopRunning = false;
  private hasRenderedFirstFrame = false;

  // Input
  private input = new Input();

  // State
  private state = GameState.Title;
  private score = 0;
  private highScore = 0;

  // HUD
  private hud!: HTMLElement;
  private titleOverlay!: HTMLElement;
  private hudScore!: HTMLElement;

  async start() {
    this.init();
    this.resumeAnimationLoop();
    signalGameReady();
  }

  private init() {
    platformInit();
    this.highScore = parseInt(localStorage.getItem("gameHighScore") || "0", 10);

    // Renderer
    const container = document.getElementById("game-container")!;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    container.insertBefore(this.renderer.domElement, container.firstChild);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020208);

    // Camera
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 5, -8);
    this.camera.lookAt(0, 0, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0x222244, 0.5);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0x4466aa, 0.8);
    dir.position.set(5, 10, 5);
    this.scene.add(dir);

    // Post-processing
    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.8, 0.3, 0.85
    );
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.bloomPass);

    // Input
    this.input.init(this.renderer.domElement);

    // Placeholder: add a rotating cube
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x00ffcc,
      emissive: 0x00ffcc,
      emissiveIntensity: 0.3,
      metalness: 0.8,
      roughness: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.scene.add(mesh);

    // HUD
    this.hud = document.getElementById("hud")!;
    this.titleOverlay = document.getElementById("title-overlay")!;
    this.hudScore = document.getElementById("hud-score")!;

    // Resize
    window.addEventListener("resize", () => this.onResize());

    registerPauseHandlers(
      () => this.pauseAnimationLoop(),
      () => this.resumeAnimationLoop()
    );
    setAudioEnabled(isAudioEnabled());
    onAudioChange((enabled) => setAudioEnabled(enabled));
    signalLoadComplete();
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
    // Placeholder: spin the crystal
    const mesh = this.scene.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;
    if (mesh) {
      mesh.rotation.y += dt * 0.5;
      mesh.rotation.x = Math.sin(performance.now() * 0.001) * 0.3;
    }

    const t = performance.now() * 0.0003;
    this.camera.position.set(Math.sin(t) * 5, 3, Math.cos(t) * 5);
    this.camera.lookAt(0, 0, 0);

    if (this.input.justPressed("space") || this.input.justPressed("click")) {
      this.startGame();
    }
  }

  private startGame() {
    initAudio();
    playClick();
    this.state = GameState.Playing;
    this.score = 0;
    this.hud.classList.remove("hidden");
    this.titleOverlay.classList.add("hidden");
  }

  private updatePlaying(dt: number) {
    // TODO: game logic here
    this.score += Math.floor(dt * 100);
    this.hudScore.textContent = String(this.score);

    // Placeholder death condition
    // if (somethingBad) this.die();
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
