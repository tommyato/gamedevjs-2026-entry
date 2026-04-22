import * as THREE from "three";
import { applyTopDownShadowToObject, type TopDownShadowUniforms } from "./shadow";

export type GearVariant = "normal" | "crumbling" | "speed" | "reverse" | "piston" | "wind" | "magnetic" | "bouncy" | "milestone";

export type GearCollision = {
  onGear: boolean;
  y: number;
  momentum: THREE.Vector3;
};

export type GearBlockResult = {
  blocked: boolean;
  capY: number;
};

export type GearOptions = {
  color?: number;
  danger?: number;
  height?: number;
  radius?: number;
  rotationSpeed?: number;
  variant?: GearVariant;
};

export class Gear {
  public readonly mesh: THREE.Group;
  public readonly radius: number;
  public readonly height: number;
  public readonly rotationSpeed: number;
  public rotationDir: number;
  public readonly variant: GearVariant;

  private readonly restPosition = new THREE.Vector3();
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly topSurfaceMaterial: THREE.MeshStandardMaterial;
  private readonly toothMaterial: THREE.MeshStandardMaterial;
  private readonly accentMaterial: THREE.MeshStandardMaterial;
  private readonly detailMaterial: THREE.MeshStandardMaterial;
  private readonly hazardColor = new THREE.Color(0xff5d42);
  private landingRingMaterial: THREE.MeshStandardMaterial | null = null;
  private landingRingBaseEmissiveIntensity = 0.5;
  private landingHighlightActive = false;
  private landingHighlightT = 0;
  private active = true;
  private crumbleArmed = false;
  private crumbleTimer = 0;
  private crumbleFallVelocity = 0;
  private crumbleFallDistance = 0;
  private reverseTimer = 0;
  private readonly reverseInterval = 3;
  private readonly reversePause = 0.35;
  private readonly shakePhase = Math.random() * Math.PI * 2;
  private readonly angularVelocityVector = new THREE.Vector3();
  private pistonMesh: THREE.Mesh | null = null;
  private pistonBaseY = 0;
  private pistonTime = Math.random() * Math.PI * 2;
  private checkpointRing: THREE.Mesh | null = null;
  private checkpointPillar: THREE.Mesh | null = null;
  private checkpointMarker: THREE.Mesh | null = null;
  private checkpointGlow: THREE.Mesh | null = null;
  private checkpointActivationPulse = 0;
  private milestoneTime = 0;
  private readonly windRings: THREE.Mesh[] = [];
  private magnetIndicator: THREE.Mesh | null = null;
  private magnetTime = 0;

  constructor(options: GearOptions = {}) {
    this.radius = options.radius ?? 1.5;
    this.height = options.height ?? 0.3;
    this.rotationSpeed = options.rotationSpeed ?? 0.5;
    this.variant = options.variant ?? "normal";
    this.rotationDir = Math.random() > 0.5 ? 1 : -1;

    const baseColor = new THREE.Color(options.color ?? 0x8b4513);
    const variantColor = applyVariantTint(baseColor, this.variant);
    const danger = options.danger ?? 0;
    const bodyColor = variantColor.clone().lerp(this.hazardColor, danger * 0.32);
    const topColor = variantColor.clone().offsetHSL(0.02, 0.12, 0.16).lerp(this.hazardColor, danger * 0.2);
    const toothColor = variantColor.clone().multiplyScalar(0.95).lerp(this.hazardColor, danger * 0.26);

    this.mesh = new THREE.Group();

    const bodyGeo = new THREE.CylinderGeometry(this.radius, this.radius, this.height, 32);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: bodyColor.clone().multiplyScalar(this.variant === "crumbling" ? 0.72 : this.variant === "milestone" ? 1.0 : 0.82),
      emissive: this.variant === "milestone" ? new THREE.Color(0xd7a530) : bodyColor.clone().multiplyScalar(0.08 + danger * 0.1),
      emissiveIntensity: this.variant === "milestone" ? 0.38 : 0.3,
      metalness: 0.9,
      roughness: this.variant === "crumbling" ? 0.48 : this.variant === "milestone" ? 0.18 : 0.34,
    });
    this.rememberMaterialDefaults(this.bodyMaterial);
    const body = new THREE.Mesh(bodyGeo, this.bodyMaterial);
    this.mesh.add(body);

    const topSurfaceGeo = new THREE.CylinderGeometry(this.radius * 0.92, this.radius * 0.92, 0.05, 32);
    this.topSurfaceMaterial = new THREE.MeshStandardMaterial({
      color: topColor,
      emissive: topColor.clone().multiplyScalar(0.2 + danger * 0.14),
      emissiveIntensity: this.variant === "milestone" ? 0.22 : 0.35,
      metalness: 0.78,
      roughness: 0.22,
    });
    this.rememberMaterialDefaults(this.topSurfaceMaterial);
    const topSurface = new THREE.Mesh(topSurfaceGeo, this.topSurfaceMaterial);
    topSurface.position.y = this.height / 2 + 0.03;
    this.mesh.add(topSurface);

    const landingRingGeo = new THREE.TorusGeometry(Math.max(this.radius * 0.72, 0.6), Math.max(this.radius * 0.06, 0.08), 10, 40);
    const ringColor = getRingColor(this.variant);
    const landingRingMat = new THREE.MeshStandardMaterial({
      color: ringColor.color,
      emissive: ringColor.emissive,
      emissiveIntensity: 0.5 + danger * 0.15,
      metalness: 0.55,
      roughness: 0.3,
    });
    const landingRing = new THREE.Mesh(landingRingGeo, landingRingMat);
    landingRing.rotation.x = Math.PI / 2;
    landingRing.position.y = this.height / 2 + 0.05;
    this.mesh.add(landingRing);
    this.landingRingMaterial = landingRingMat;
    this.landingRingBaseEmissiveIntensity = landingRingMat.emissiveIntensity;

    const hubGeo = new THREE.CylinderGeometry(this.radius * 0.22, this.radius * 0.22, this.height + 0.04, 16);
    this.detailMaterial = new THREE.MeshStandardMaterial({
      color: this.variant === "crumbling" ? 0x1d1817 : this.variant === "milestone" ? 0xaa8800 : 0x2b2623,
      emissive: this.variant === "speed" ? 0x11355e : this.variant === "milestone" ? 0xcc9500 : 0x150f0a,
      emissiveIntensity: this.variant === "speed" ? 0.5 : this.variant === "milestone" ? 0.34 : 0.35,
      metalness: 0.92,
      roughness: 0.26,
    });
    this.rememberMaterialDefaults(this.detailMaterial);
    const hub = new THREE.Mesh(hubGeo, this.detailMaterial);
    hub.position.y = 0.01;
    this.mesh.add(hub);

    const spokeGeo = new THREE.BoxGeometry(this.radius * 1.15, 0.08, Math.max(this.radius * 0.1, 0.16));
    const accentColor = getAccentColor(this.variant);
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: accentColor.color,
      emissive: accentColor.emissive,
      emissiveIntensity: this.variant === "milestone" ? 0.38 : accentColor.emissiveIntensity,
      metalness: 0.72,
      roughness: 0.24,
    });
    this.rememberMaterialDefaults(this.accentMaterial);
    const spokeCount = 3;
    for (let index = 0; index < spokeCount; index += 1) {
      const spoke = new THREE.Mesh(spokeGeo, this.accentMaterial);
      spoke.position.y = this.height / 2 + 0.065;
      spoke.rotation.y = (index / spokeCount) * Math.PI * 2 + Math.PI / 8;
      this.mesh.add(spoke);
    }

    const markerGeo = new THREE.BoxGeometry(Math.max(this.radius * 0.26, 0.2), 0.12, Math.max(this.radius * 0.1, 0.14));
    const markerMat = new THREE.MeshStandardMaterial({
      color: this.variant === "speed" ? 0x9ef5ff : this.variant === "reverse" ? 0xffb4aa : 0x9ef5ff,
      emissive: this.variant === "speed" ? 0x58e1ff : this.variant === "reverse" ? 0xff5a44 : 0x58e1ff,
      emissiveIntensity: this.variant === "milestone" ? 0.42 : 0.65,
      metalness: 0.4,
      roughness: 0.18,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(this.radius * 0.55, this.height / 2 + 0.08, 0);
    this.mesh.add(marker);

    const toothGeo = new THREE.BoxGeometry(0.2, this.height, 0.4);
    this.toothMaterial = new THREE.MeshStandardMaterial({
      color: toothColor,
      emissive: toothColor.clone().multiplyScalar(0.1 + danger * 0.1),
      emissiveIntensity: 0.3,
      metalness: 0.88,
      roughness: 0.24,
    });
    this.rememberMaterialDefaults(this.toothMaterial);
    const toothCount = Math.floor(this.radius * 10);
    for (let index = 0; index < toothCount; index += 1) {
      const angle = (index / toothCount) * Math.PI * 2;
      const tooth = new THREE.Mesh(toothGeo, this.toothMaterial);
      tooth.position.set(Math.cos(angle) * this.radius, 0, Math.sin(angle) * this.radius);
      tooth.rotation.y = -angle;
      this.mesh.add(tooth);
    }

    if (this.variant === "crumbling") {
      this.addCrackDetails();
    }

    if (this.variant === "piston") {
      this.addPistonDetail();
    }

    if (this.variant === "milestone") {
      this.addMilestoneEffects();
    }

    if (this.variant === "wind") {
      this.addWindRings();
    }

    if (this.variant === "magnetic") {
      this.addMagnetIndicator();
    }

  }

  enableTopDownShadow(uniforms: TopDownShadowUniforms) {
    applyTopDownShadowToObject(this.mesh, uniforms);
  }

  triggerMilestoneActivation() {
    this.checkpointActivationPulse = 1;
  }

  // Landing-indicator rim glow. Boosts the existing landingRing's emissive so the
  // destination gear is clearly distinguished mid-fall. Cleared on retarget/land.
  setLandingHighlight(active: boolean) {
    this.landingHighlightActive = active;
  }

  updateLandingHighlight(dt: number) {
    const ring = this.landingRingMaterial;
    if (!ring) {
      return;
    }
    const target = this.landingHighlightActive ? 1 : 0;
    this.landingHighlightT = THREE.MathUtils.lerp(this.landingHighlightT, target, 1 - Math.exp(-dt * 10));
    const boost = this.landingHighlightT * 0.9; // amber emissive bump
    ring.emissiveIntensity = this.landingRingBaseEmissiveIntensity + boost;
  }

  private addPistonDetail() {
    const shaftGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.6, 16);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x88ddaa,
      emissive: 0x2a6b45,
      emissiveIntensity: 0.55,
      metalness: 0.88,
      roughness: 0.24,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    this.pistonBaseY = this.height / 2 + 0.32;
    shaft.position.y = this.pistonBaseY;
    this.mesh.add(shaft);
    this.pistonMesh = shaft;

    const capGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.08, 16);
    const capMat = new THREE.MeshStandardMaterial({
      color: 0xc8ffd4,
      emissive: 0x66cc66,
      emissiveIntensity: 0.7,
      metalness: 0.7,
      roughness: 0.18,
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.34;
    shaft.add(cap);
  }

  private addMilestoneEffects() {    // Pulsing beacon ring (animated in update())
    const beacon = new THREE.Group();
    beacon.position.y = this.height / 2 + 0.06;

    const pulseRingGeo = new THREE.TorusGeometry(this.radius * 1.08, Math.max(this.radius * 0.035, 0.055), 8, 40);
    const pulseRingMat = new THREE.MeshStandardMaterial({
      color: 0xffdf9a,
      emissive: new THREE.Color(0xffb84a),
      emissiveIntensity: 0.34,
      metalness: 0.46,
      roughness: 0.2,
      transparent: true,
      opacity: 0.86,
    });
    const pulseRing = new THREE.Mesh(pulseRingGeo, pulseRingMat);
    pulseRing.rotation.x = Math.PI / 2;
    pulseRing.userData.skipTopDownShadowCaster = true;
    beacon.add(pulseRing);
    this.checkpointRing = pulseRing;

    const pillarGeo = new THREE.CylinderGeometry(Math.max(this.radius * 0.048, 0.06), Math.max(this.radius * 0.065, 0.08), 0.84, 10);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xb9922a,
      emissive: 0x553b07,
      emissiveIntensity: 0.22,
      metalness: 0.72,
      roughness: 0.28,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = 0.35;
    beacon.add(pillar);
    this.checkpointPillar = pillar;

    const markerGeo = new THREE.OctahedronGeometry(Math.max(this.radius * 0.18, 0.14), 0);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xffe18c,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.y = 0.92;
    marker.rotation.y = Math.PI * 0.25;
    marker.userData.skipTopDownShadowCaster = true;
    beacon.add(marker);
    this.checkpointMarker = marker;

    const haloGeo = new THREE.TorusGeometry(this.radius * 0.92, Math.max(this.radius * 0.022, 0.032), 8, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffcf66,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.1;
    halo.userData.skipTopDownShadowCaster = true;
    beacon.add(halo);
    this.checkpointGlow = halo;

    this.mesh.add(beacon);
  }

  private addWindRings() {
    // Two expanding gust rings staggered by half a cycle, showing the "wind" nature
    const ringGeo = new THREE.TorusGeometry(this.radius * 0.82, Math.max(this.radius * 0.033, 0.048), 8, 32);
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xaaddff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = this.height / 2 + 0.08;
      ring.userData.windPhaseOffset = i * 0.5;
      ring.userData.skipTopDownShadowCaster = true;
      this.mesh.add(ring);
      this.windRings.push(ring);
    }
  }

  private addMagnetIndicator() {
    const indicatorGeo = new THREE.CircleGeometry(1, 28);
    const indicatorMat = new THREE.MeshBasicMaterial({
      color: 0xc074ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const indicator = new THREE.Mesh(indicatorGeo, indicatorMat);
    indicator.rotation.x = Math.PI / 2;
    indicator.position.y = this.height / 2 + 0.09;
    indicator.userData.skipTopDownShadowCaster = true;
    this.mesh.add(indicator);
    this.magnetIndicator = indicator;
  }

  // Called from game.ts updateWorld() — drives the wind ring pulse animation.
  updateWindRings(elapsedTime: number) {
    if (this.windRings.length === 0) return;
    const CYCLE = 1.4;
    for (const ring of this.windRings) {
      const phase = ((elapsedTime / CYCLE) + (ring.userData.windPhaseOffset as number)) % 1;
      // Expand from 0.55× to 1.35× original size
      ring.scale.setScalar(0.55 + phase * 0.8);
      // Fade in quickly, then fade out slowly
      const opacity = phase < 0.15 ? phase / 0.15 : (1 - phase) / 0.85;
      (ring.material as THREE.MeshBasicMaterial).opacity = opacity * 0.62;
    }
  }

  // Called from game.ts updateWorld() — drives the magnetic center pulse.
  updateMagnetIndicator(elapsedTime: number) {
    if (!this.magnetIndicator) {
      return;
    }

    this.magnetTime = elapsedTime;
    const cycle = 1.2;
    const phase = (this.magnetTime % cycle) / cycle;
    const envelope = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const pulseScale = THREE.MathUtils.lerp(0.3, 0.5, envelope) * this.radius;
    const material = this.magnetIndicator.material as THREE.MeshBasicMaterial;

    this.magnetIndicator.scale.setScalar(pulseScale);
    this.magnetIndicator.position.y = this.height / 2 + 0.085 + envelope * 0.02;
    material.opacity = THREE.MathUtils.lerp(0.1, 0.42, envelope);
  }

  private addCrackDetails() {
    const crackMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2120,
      emissive: 0x120c0c,
      emissiveIntensity: 0.2,
      metalness: 0.35,
      roughness: 0.72,
    });
    const crackGeo = new THREE.BoxGeometry(this.radius * 0.75, 0.03, 0.05);
    for (let index = 0; index < 3; index += 1) {
      const crack = new THREE.Mesh(crackGeo, crackMaterial);
      crack.position.y = this.height / 2 + 0.065;
      crack.rotation.y = this.shakePhase + index * 0.9;
      crack.position.x = Math.cos(index * 2.1) * this.radius * 0.12;
      crack.position.z = Math.sin(index * 1.7) * this.radius * 0.12;
      this.mesh.add(crack);
    }
  }

  setPosition(x: number, y: number, z: number) {
    this.restPosition.set(x, y, z);
    this.mesh.position.copy(this.restPosition);
  }

  getPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.mesh.position);
  }

  getTopY(): number {
    return this.mesh.position.y + this.height / 2 + 0.12;
  }

  isSolid(): boolean {
    return this.active;
  }

  onPlayerLand() {
    if (this.variant === "crumbling" && !this.crumbleArmed) {
      this.crumbleArmed = true;
      this.crumbleTimer = 0;
    }
  }

  syncCrumbleVisuals(crumbleArmed: boolean, crumbleTimer: number, crumbleFallDistance: number) {
    if (!crumbleArmed) {
      this.mesh.scale.setScalar(1);
      this.mesh.rotation.x = 0;
      this.mesh.rotation.z = 0;
      this.resetMaterialVisuals();
      return;
    }

    const warning = THREE.MathUtils.clamp((crumbleTimer - 0.22) / 1.05, 0, 1);
    const collapse = THREE.MathUtils.clamp((crumbleTimer - 1.5) / 0.4, 0, 1);
    const shake = Math.sin(crumbleTimer * 52 + this.shakePhase);
    const wobble = 0.012 + warning * 0.04;

    this.mesh.scale.setScalar(1 - warning * 0.03 - collapse * 0.14);
    this.mesh.rotation.x = Math.sin(crumbleTimer * 24 + this.shakePhase * 0.7) * wobble * 0.35 + collapse * 0.18;
    this.mesh.rotation.z = shake * wobble;

    const fade = collapse > 0 ? 1 - collapse * 0.92 : 1;
    const urgency = Math.max(warning, collapse * 1.1);
    this.applyCrumbleMaterialState(urgency, fade, crumbleFallDistance);
  }

  setFreezeEmissive(active: boolean) {
    if (active) {
      const iceColor = new THREE.Color(0x88ccff);
      for (const mat of [this.bodyMaterial, this.topSurfaceMaterial, this.toothMaterial]) {
        mat.emissive.lerp(iceColor, 0.55);
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 0.15);
      }
    } else {
      this.resetMaterialVisuals();
    }
  }

  getAngularVelocity(): number {
    if (!this.active) {
      return 0;
    }

    if (this.variant === "reverse") {
      const cycleTime = this.reverseTimer % this.reverseInterval;
      if (cycleTime >= this.reverseInterval - this.reversePause) {
        return 0;
      }
    }

    const multiplier = this.variant === "speed" ? 2 : 1;
    return this.rotationSpeed * multiplier * this.rotationDir;
  }

  update(dt: number) {
    if (this.pistonMesh) {
      this.pistonTime += dt;
      const oscillation = Math.sin((this.pistonTime / 1.5) * Math.PI * 2) * 0.15;
      this.pistonMesh.position.y = this.pistonBaseY + oscillation;
    }

    if (this.checkpointRing) {
      this.milestoneTime += dt;
      this.checkpointActivationPulse = Math.max(0, this.checkpointActivationPulse - dt * 1.8);
      const idlePulse = 1 + Math.sin(this.milestoneTime * 2.6) * 0.045;
      const activation = this.checkpointActivationPulse;
      const ringScale = idlePulse + activation * 0.16;
      this.checkpointRing.scale.setScalar(ringScale);

      const ringMaterial = this.checkpointRing.material as THREE.MeshStandardMaterial;
      ringMaterial.emissiveIntensity = 0.3 + Math.sin(this.milestoneTime * 2.6) * 0.05 + activation * 0.48;
      ringMaterial.opacity = 0.82 + activation * 0.08;

      if (this.checkpointPillar) {
        this.checkpointPillar.scale.setScalar(1 + activation * 0.08);
        this.checkpointPillar.rotation.y = this.milestoneTime * 0.55;
        const pillarMaterial = this.checkpointPillar.material as THREE.MeshStandardMaterial;
        pillarMaterial.emissiveIntensity = 0.18 + activation * 0.22;
      }

      if (this.checkpointMarker) {
        const markerMaterial = this.checkpointMarker.material as THREE.MeshBasicMaterial;
        this.checkpointMarker.scale.setScalar(1 + activation * 0.28);
        this.checkpointMarker.position.y = 0.92 + Math.sin(this.milestoneTime * 3.2) * 0.03 + activation * 0.08;
        this.checkpointMarker.rotation.y += dt * (1.1 + activation * 1.2);
        markerMaterial.opacity = 0.86 + activation * 0.14;
      }

      if (this.checkpointGlow) {
        const glowMaterial = this.checkpointGlow.material as THREE.MeshBasicMaterial;
        this.checkpointGlow.scale.setScalar(0.92 + activation * 0.2 + Math.sin(this.milestoneTime * 1.8) * 0.03);
        glowMaterial.opacity = 0.08 + activation * 0.12;
      }
    }

    this.reverseTimer += dt;
    if (this.variant === "reverse" && this.reverseTimer >= this.reverseInterval) {
      this.reverseTimer -= this.reverseInterval;
      this.rotationDir *= -1;
    }

    this.mesh.rotation.y += this.getAngularVelocity() * dt;

    if (!this.crumbleArmed) {
      this.mesh.position.copy(this.restPosition);
      return;
    }

    this.crumbleTimer += dt;
    if (this.crumbleTimer >= 1.5) {
      this.active = false;
      this.crumbleFallVelocity += 25 * dt;
      this.crumbleFallDistance += this.crumbleFallVelocity * dt;
      this.mesh.position.copy(this.restPosition);
      this.mesh.position.y -= this.crumbleFallDistance;
      this.mesh.rotation.z += dt * 2.4;
      this.mesh.rotation.x += dt * 1.8;
      return;
    }

    if (this.crumbleTimer >= 0.3) {
      const shakeStrength = THREE.MathUtils.mapLinear(this.crumbleTimer, 0.3, 1.5, 0.03, 0.18);
      const time = this.crumbleTimer * 50 + this.shakePhase;
      this.mesh.position.copy(this.restPosition);
      this.mesh.position.x += Math.sin(time) * shakeStrength;
      this.mesh.position.z += Math.cos(time * 1.3) * shakeStrength;
      this.mesh.position.y += Math.sin(time * 2.1) * shakeStrength * 0.3;

      // Warning color: tint body red as crumble progresses
      const urgency = THREE.MathUtils.mapLinear(this.crumbleTimer, 0.3, 1.5, 0, 0.6);
      this.bodyMaterial.emissive.setRGB(urgency * 1.2, urgency * 0.15, 0);
      this.bodyMaterial.emissiveIntensity = 0.3 + urgency * 1.4;
      return;
    }

    this.mesh.position.copy(this.restPosition);
  }

  checkCollision(playerPos: THREE.Vector3, playerRadius: number): GearCollision {
    if (!this.active) {
      return { onGear: false, y: 0, momentum: new THREE.Vector3() };
    }

    const distSq = (playerPos.x - this.mesh.position.x) ** 2 + (playerPos.z - this.mesh.position.z) ** 2;
    const combinedRadius = this.radius + playerRadius + 0.02;
    const gearTop = this.getTopY();
    const isAbove = playerPos.y >= gearTop - 0.2 && playerPos.y <= gearTop + 0.2;

    if (distSq < combinedRadius * combinedRadius && isAbove) {
      const dx = playerPos.x - this.mesh.position.x;
      const dz = playerPos.z - this.mesh.position.z;
      const angularVelocity = this.getAngularVelocity();
      this.angularVelocityVector.set(dz * angularVelocity, 0, -dx * angularVelocity);
      return {
        onGear: true,
        y: gearTop,
        momentum: this.angularVelocityVector.clone(),
      };
    }

    return { onGear: false, y: 0, momentum: new THREE.Vector3() };
  }

  checkBlockFromBelow(playerPos: THREE.Vector3, playerHeight: number, playerRadius: number): GearBlockResult {
    if (!this.active) {
      return { blocked: false, capY: 0 };
    }

    const distSq = (playerPos.x - this.mesh.position.x) ** 2 + (playerPos.z - this.mesh.position.z) ** 2;
    const combinedRadius = this.radius * 0.85 + playerRadius;
    if (distSq >= combinedRadius * combinedRadius) {
      return { blocked: false, capY: 0 };
    }

    const gearBottom = this.mesh.position.y - this.height / 2;
    const playerTop = playerPos.y + playerHeight;

    if (playerPos.y < gearBottom && playerTop > gearBottom + 0.05) {
      return { blocked: true, capY: gearBottom - playerHeight };
    }

    return { blocked: false, capY: 0 };
  }

  private rememberMaterialDefaults(material: THREE.MeshStandardMaterial) {
    material.userData.baseColor = material.color.clone();
    material.userData.baseEmissive = material.emissive.clone();
    material.userData.baseEmissiveIntensity = material.emissiveIntensity;
    material.userData.baseOpacity = material.opacity;
    material.userData.baseTransparent = material.transparent;
  }

  private resetMaterialVisuals() {
    this.applyMaterialDefaults(this.bodyMaterial);
    this.applyMaterialDefaults(this.topSurfaceMaterial);
    this.applyMaterialDefaults(this.detailMaterial);
    this.applyMaterialDefaults(this.accentMaterial);
    this.applyMaterialDefaults(this.toothMaterial);
  }

  private applyMaterialDefaults(material: THREE.MeshStandardMaterial) {
    const baseColor = material.userData.baseColor as THREE.Color | undefined;
    const baseEmissive = material.userData.baseEmissive as THREE.Color | undefined;
    if (baseColor) {
      material.color.copy(baseColor);
    }
    if (baseEmissive) {
      material.emissive.copy(baseEmissive);
    }
    material.emissiveIntensity = (material.userData.baseEmissiveIntensity as number | undefined) ?? material.emissiveIntensity;
    material.opacity = (material.userData.baseOpacity as number | undefined) ?? 1;
    material.transparent = (material.userData.baseTransparent as boolean | undefined) ?? false;
  }

  private applyCrumbleMaterialState(urgency: number, fade: number, crumbleFallDistance: number) {
    const collapseTint = THREE.MathUtils.clamp(urgency, 0, 1);
    const fallTint = THREE.MathUtils.clamp(crumbleFallDistance * 0.15, 0, 0.35);
    const materials = [this.bodyMaterial, this.topSurfaceMaterial, this.detailMaterial, this.accentMaterial, this.toothMaterial];

    for (const material of materials) {
      const baseColor = material.userData.baseColor as THREE.Color | undefined;
      const baseEmissive = material.userData.baseEmissive as THREE.Color | undefined;
      if (baseColor) {
        material.color.copy(baseColor).lerp(this.hazardColor, collapseTint * 0.46);
      }
      if (baseEmissive) {
        material.emissive.copy(baseEmissive).lerp(this.hazardColor, collapseTint * 0.75 + fallTint);
      }
      const baseIntensity = (material.userData.baseEmissiveIntensity as number | undefined) ?? 0.3;
      material.emissiveIntensity = baseIntensity + collapseTint * 1.1 + fallTint * 0.65;
      material.opacity = fade;
      material.transparent = fade < 1;
    }
  }
}

function applyVariantTint(baseColor: THREE.Color, variant: GearVariant): THREE.Color {
  const color = baseColor.clone();
  if (variant === "crumbling") return color.multiplyScalar(0.82);
  if (variant === "speed") return color.lerp(new THREE.Color(0x49a6ff), 0.42);
  if (variant === "reverse") return color.lerp(new THREE.Color(0xff6852), 0.5);
  if (variant === "piston") return color.lerp(new THREE.Color(0x66cc66), 0.3);
  if (variant === "wind") return color.lerp(new THREE.Color(0x4488aa), 0.55);
  if (variant === "magnetic") return color.lerp(new THREE.Color(0x8844aa), 0.55);
  if (variant === "bouncy") return color.lerp(new THREE.Color(0x44aa44), 0.55);
  if (variant === "milestone") return new THREE.Color(0xffd700); // pure gold, overrides base
  return color;
}

function getRingColor(variant: GearVariant): { color: number; emissive: number } {
  switch (variant) {
    case "speed": return { color: 0x95dfff, emissive: 0x57b9ff };
    case "reverse": return { color: 0xff8876, emissive: 0xff5a44 };
    case "wind": return { color: 0x88ddff, emissive: 0x44aaff };
    case "magnetic": return { color: 0xcc88ff, emissive: 0x8844cc };
    case "bouncy": return { color: 0x88ff88, emissive: 0x44cc44 };
    case "milestone": return { color: 0xffffff, emissive: 0xffd700 };
    default: return { color: 0xffcf8e, emissive: 0xffb14a };
  }
}

function getAccentColor(variant: GearVariant): { color: number; emissive: number; emissiveIntensity: number } {
  switch (variant) {
    case "speed": return { color: 0xb7efff, emissive: 0x4ab8ff, emissiveIntensity: 0.35 };
    case "reverse": return { color: 0xff8c7a, emissive: 0xff694f, emissiveIntensity: 0.45 };
    case "wind": return { color: 0x88ccff, emissive: 0x4499ff, emissiveIntensity: 0.40 };
    case "magnetic": return { color: 0xcc88ff, emissive: 0x9933ff, emissiveIntensity: 0.42 };
    case "bouncy": return { color: 0x88ff88, emissive: 0x44cc44, emissiveIntensity: 0.42 };
    case "milestone": return { color: 0xffd700, emissive: 0xffaa00, emissiveIntensity: 0.6 };
    default: return { color: 0xf6b86f, emissive: 0xffa43c, emissiveIntensity: 0.35 };
  }
}
