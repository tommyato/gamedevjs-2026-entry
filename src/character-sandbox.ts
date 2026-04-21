import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createWindUpAutomaton } from "./characters/wind-up-automaton";

export function mountCharacterSandbox(container: HTMLElement): void {
  // Hide the main game's DOM overlays (title card, HUD, etc.) so the sandbox
  // canvas isn't occluded.
  const gameContainer = document.getElementById("game-container");
  if (gameContainer) {
    gameContainer.style.display = "none";
  }

  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  scene.fog = new THREE.Fog(0x1a1a1a, 8, 20);

  // Camera
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(2, 1.5, 2);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Orbit controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 1;
  controls.maxDistance = 6;
  controls.target.set(0, 0.5, 0);
  controls.update();

  // Studio lighting
  // Hemisphere light for ambient fill
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  hemiLight.position.set(0, 20, 0);
  scene.add(hemiLight);

  // Key directional light (main light)
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(5, 8, 5);
  keyLight.castShadow = true;
  keyLight.shadow.camera.left = -5;
  keyLight.shadow.camera.right = 5;
  keyLight.shadow.camera.top = 5;
  keyLight.shadow.camera.bottom = -5;
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 30;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  scene.add(keyLight);

  // Fill light (subtle)
  const fillLight = new THREE.DirectionalLight(0xaaccff, 0.4);
  fillLight.position.set(-3, 4, -2);
  scene.add(fillLight);

  // Ground plane / turntable
  const groundGeo = new THREE.CircleGeometry(3, 32);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x333333,
    metalness: 0.1,
    roughness: 0.8,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Turntable rim (optional visual flourish)
  const rimGeo = new THREE.TorusGeometry(3, 0.02, 8, 64);
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x666666,
    metalness: 0.6,
    roughness: 0.4,
  });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.01;
  scene.add(rim);

  // Character
  const automaton = createWindUpAutomaton();
  automaton.group.castShadow = true;
  automaton.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  scene.add(automaton.group);

  // HUD label (minimal corner label)
  const label = document.createElement("div");
  label.style.position = "absolute";
  label.style.bottom = "10px";
  label.style.right = "10px";
  label.style.color = "#888";
  label.style.fontFamily = "monospace";
  label.style.fontSize = "11px";
  label.style.pointerEvents = "none";
  label.textContent = "Character sandbox — wind-up automaton v1";
  container.appendChild(label);

  // Resize handler
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  // Animation loop
  let lastTime = performance.now();
  const animate = () => {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Update character (wind-up key rotation)
    automaton.update(dt);

    // Update controls
    controls.update();

    // Render
    renderer.render(scene, camera);
  };

  animate();
}
