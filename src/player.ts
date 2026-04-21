import * as THREE from "three";
import { Input } from "./input";
import { applyTopDownShadowToObject, type TopDownShadowUniforms } from "./shadow";

export type PlayerUpdateResult = {
  jumped: boolean;
};

export class Player {
  public mesh = new THREE.Group();
  public velocity = new THREE.Vector3();
  public onGround = false;
  public prevY = 0;
  private radius = 0.3;
  private height = 0.6;
  private readonly moveSpeed = 5;
  public highestY = 0;
  private readonly visualRoot = new THREE.Group();
  private readonly doubleJumpAura: THREE.Mesh;
  private scaleYImpulse = 0;
  private speedBoostTimer = 0;
  private speedBoostStrength = 1;
  private doubleJumpCharges = 0;
  private doubleJumpPulse = 0;
  public readonly bodyMaterial: THREE.MeshStandardMaterial;

  constructor() {
    this.mesh.add(this.visualRoot);

    // Body
    const bodyGeo = new THREE.CylinderGeometry(this.radius, this.radius, this.height, 12);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xcd7f32, // Bronze
      metalness: 0.9,
      roughness: 0.22
    });
    this.bodyMaterial = bodyMat;
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = this.height / 2;
    this.visualRoot.add(body);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 1.5,
      metalness: 0.1,
      roughness: 0.15
    });

    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.1, 0.45, 0.25);
    this.visualRoot.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.1, 0.45, 0.25);
    this.visualRoot.add(rightEye);

    const auraGeo = new THREE.TorusGeometry(0.48, 0.05, 8, 18);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0x6ee7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.position.y = 0.42;
    aura.rotation.x = Math.PI / 2;
    aura.visible = false;
    aura.userData.skipTopDownShadowCaster = true;
    this.doubleJumpAura = aura;
    this.visualRoot.add(aura);
  }

  enableTopDownShadow(uniforms: TopDownShadowUniforms) {
    applyTopDownShadowToObject(this.mesh, uniforms);
  }

  update(dt: number, input: Input, cameraAngle = 0): PlayerUpdateResult {
    this.prevY = this.mesh.position.y;
    const move = input.getMovement();
    let jumped = false;
    this.speedBoostTimer = Math.max(0, this.speedBoostTimer - dt);
    const speedBoost = this.speedBoostTimer > 0
      ? THREE.MathUtils.lerp(this.speedBoostStrength, 1, 1 - this.speedBoostTimer / 0.9)
      : 1;
    const speed = this.moveSpeed * speedBoost;

    // Transform input to camera-relative world space.
    // Camera sits at (cos(θ)*r, h, sin(θ)*r). Screen-right maps to the
    // camera's right vector and screen-up (W, move.y=-1) maps to the
    // camera's forward vector.  The standard 2D rotation with angle
    // (θ - π/2) achieves this mapping correctly.
    const cameraYaw = cameraAngle - Math.PI / 2;
    const sinYaw = Math.sin(cameraYaw);
    const cosYaw = Math.cos(cameraYaw);
    const worldX = move.x * cosYaw - move.y * sinYaw;
    const worldZ = move.x * sinYaw + move.y * cosYaw;

    this.mesh.position.x += worldX * speed * dt;
    this.mesh.position.z += worldZ * speed * dt;

    // Gravity
    if (!this.onGround) {
      this.velocity.y -= 20 * dt;
    } else {
      this.velocity.y = 0;
    }

    // Jump
    if (this.onGround && input.justPressed("space")) {
      this.velocity.y = 12;
      this.onGround = false;
      this.scaleYImpulse = 0.35;
      jumped = true;
    }

    this.mesh.position.y += this.velocity.y * dt;

    if (this.mesh.position.y > this.highestY) {
      this.highestY = this.mesh.position.y;
    }

    // Look in movement direction (world space)
    if (Math.abs(move.x) > 0.1 || Math.abs(move.y) > 0.1) {
      const angle = Math.atan2(worldX, worldZ);
      this.mesh.rotation.y = angle;
    }

    const verticalVelocityFactor = THREE.MathUtils.clamp(this.velocity.y / 14, -1, 1);
    const airborneScaleY = verticalVelocityFactor > 0
      ? verticalVelocityFactor * 0.25
      : verticalVelocityFactor * 0.18;
    const targetScaleY = 1 + airborneScaleY + this.scaleYImpulse;
    const targetScaleXZ = 1 - (targetScaleY - 1) * 0.55;
    const scaleLerp = 1 - Math.exp(-dt * 18);
    this.visualRoot.scale.x = THREE.MathUtils.lerp(this.visualRoot.scale.x, targetScaleXZ, scaleLerp);
    this.visualRoot.scale.y = THREE.MathUtils.lerp(this.visualRoot.scale.y, targetScaleY, scaleLerp);
    this.visualRoot.scale.z = THREE.MathUtils.lerp(this.visualRoot.scale.z, targetScaleXZ, scaleLerp);
    this.scaleYImpulse = THREE.MathUtils.lerp(this.scaleYImpulse, 0, 1 - Math.exp(-dt * 12));

    const targetLean = THREE.MathUtils.clamp(-move.x * 0.16, -0.16, 0.16);
    this.visualRoot.rotation.z = THREE.MathUtils.lerp(
      this.visualRoot.rotation.z,
      targetLean,
      1 - Math.exp(-dt * 10)
    );

    const auraMaterial = this.doubleJumpAura.material as THREE.MeshBasicMaterial;
    if (this.doubleJumpCharges > 0) {
      this.doubleJumpPulse += dt * 5.2;
      this.doubleJumpAura.visible = true;
      const baseOpacity = 0.15 + Math.min(this.doubleJumpCharges, 9) * 0.03;
      const targetOpacity = baseOpacity + Math.sin(this.doubleJumpPulse) * 0.05;
      auraMaterial.opacity = THREE.MathUtils.lerp(auraMaterial.opacity, targetOpacity, 1 - Math.exp(-dt * 6));
      this.doubleJumpAura.scale.setScalar(1 + Math.sin(this.doubleJumpPulse * 1.2) * 0.045);
      this.doubleJumpAura.rotation.z += dt * 1.2;
    } else {
      this.doubleJumpPulse = 0;
      auraMaterial.opacity = THREE.MathUtils.lerp(auraMaterial.opacity, 0, 1 - Math.exp(-dt * 5));
      if (auraMaterial.opacity < 0.01) {
        this.doubleJumpAura.visible = false;
        auraMaterial.opacity = 0;
        this.doubleJumpAura.scale.setScalar(1);
      }
    }

    return { jumped };
  }

  setDyingVisual() {
    this.bodyMaterial.emissive.setHex(0xff3333);
    this.bodyMaterial.emissiveIntensity = 1.5;
  }

  setBodyOpacity(opacity: number) {
    this.bodyMaterial.transparent = opacity < 1;
    this.bodyMaterial.opacity = opacity;
  }

  resetVisuals() {
    this.bodyMaterial.emissive.setHex(0x000000);
    this.bodyMaterial.emissiveIntensity = 0;
    this.bodyMaterial.transparent = false;
    this.bodyMaterial.opacity = 1;
  }

  land(impactSpeed: number) {
    this.scaleYImpulse = -THREE.MathUtils.clamp(impactSpeed * 0.04, 0.12, 0.32);
  }

  bonk(impactSpeed: number) {
    this.scaleYImpulse = -THREE.MathUtils.clamp(impactSpeed * 0.028, 0.08, 0.24);
  }

  giveSpeedBoost(multiplier: number, duration: number) {
    this.speedBoostStrength = Math.max(this.speedBoostStrength, multiplier);
    this.speedBoostTimer = Math.max(this.speedBoostTimer, duration);
  }

  setDoubleJumpCharges(charges: number) {
    this.doubleJumpCharges = charges;
    if (charges === 0) {
      this.doubleJumpPulse = 0;
    }
  }

  reset(y = 0, z = 0) {
    this.mesh.position.set(0, y, z);
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    this.highestY = y;
    this.prevY = y;
    this.scaleYImpulse = 0;
    this.speedBoostTimer = 0;
    this.speedBoostStrength = 1;
    this.doubleJumpCharges = 0;
    this.doubleJumpPulse = 0;
    this.visualRoot.scale.setScalar(1);
    this.visualRoot.rotation.set(0, 0, 0);
    this.resetVisuals();
    this.doubleJumpAura.visible = false;
    this.doubleJumpAura.scale.setScalar(1);
    const auraMaterial = this.doubleJumpAura.material as THREE.MeshBasicMaterial;
    auraMaterial.opacity = 0;
  }
}
