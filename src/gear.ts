import * as THREE from "three";

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
  private milestoneRing: THREE.Mesh | null = null;
  private milestoneTime = 0;

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
      emissive: this.variant === "milestone" ? new THREE.Color(0xffaa00) : bodyColor.clone().multiplyScalar(0.08 + danger * 0.1),
      emissiveIntensity: this.variant === "milestone" ? 0.6 : 0.3,
      metalness: 0.9,
      roughness: this.variant === "crumbling" ? 0.48 : this.variant === "milestone" ? 0.18 : 0.34,
    });
    const body = new THREE.Mesh(bodyGeo, this.bodyMaterial);
    this.mesh.add(body);

    const topSurfaceGeo = new THREE.CylinderGeometry(this.radius * 0.92, this.radius * 0.92, 0.05, 32);
    this.topSurfaceMaterial = new THREE.MeshStandardMaterial({
      color: topColor,
      emissive: topColor.clone().multiplyScalar(0.22 + danger * 0.16),
      emissiveIntensity: 0.35,
      metalness: 0.78,
      roughness: 0.22,
    });
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

    const hubGeo = new THREE.CylinderGeometry(this.radius * 0.22, this.radius * 0.22, this.height + 0.04, 16);
    this.detailMaterial = new THREE.MeshStandardMaterial({
      color: this.variant === "crumbling" ? 0x1d1817 : this.variant === "milestone" ? 0xaa8800 : 0x2b2623,
      emissive: this.variant === "speed" ? 0x11355e : this.variant === "milestone" ? 0xffaa00 : 0x150f0a,
      emissiveIntensity: this.variant === "speed" ? 0.5 : this.variant === "milestone" ? 0.5 : 0.35,
      metalness: 0.92,
      roughness: 0.26,
    });
    const hub = new THREE.Mesh(hubGeo, this.detailMaterial);
    hub.position.y = 0.01;
    this.mesh.add(hub);

    const spokeGeo = new THREE.BoxGeometry(this.radius * 1.15, 0.08, Math.max(this.radius * 0.1, 0.16));
    const accentColor = getAccentColor(this.variant);
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: accentColor.color,
      emissive: accentColor.emissive,
      emissiveIntensity: accentColor.emissiveIntensity,
      metalness: 0.72,
      roughness: 0.24,
    });
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
      emissiveIntensity: 0.65,
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

    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
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

  private addMilestoneEffects() {
    // Pulsing beacon ring (animated in update())
    const pulseRingGeo = new THREE.TorusGeometry(this.radius * 1.08, Math.max(this.radius * 0.045, 0.07), 10, 48);
    const pulseRingMat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: new THREE.Color(0xffcc00),
      emissiveIntensity: 0.9,
      metalness: 0.6,
      roughness: 0.12,
      transparent: true,
      opacity: 0.88,
    });
    const pulseRing = new THREE.Mesh(pulseRingGeo, pulseRingMat);
    pulseRing.rotation.x = Math.PI / 2;
    pulseRing.position.y = this.height / 2 + 0.08;
    this.mesh.add(pulseRing);
    this.milestoneRing = pulseRing;

    // Subtle additive glow sphere
    const glowGeo = new THREE.SphereGeometry(this.radius * 1.18, 16, 12);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffdd44,
      transparent: true,
      opacity: 0.07,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const glowSphere = new THREE.Mesh(glowGeo, glowMat);
    this.mesh.add(glowSphere);
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

    if (this.milestoneRing) {
      this.milestoneTime += dt;
      const pulse = 1 + Math.sin(this.milestoneTime * 2.8) * 0.07;
      this.milestoneRing.scale.setScalar(pulse);
      (this.milestoneRing.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.65 + Math.sin(this.milestoneTime * 2.8) * 0.32;
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
