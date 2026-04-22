import * as THREE from "three";
import { Input } from "./input";
import { createWindUpAutomaton, type WindUpAutomaton } from "./characters/wind-up-automaton";
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
  private readonly automaton: WindUpAutomaton;
  private readonly doubleJumpAura: THREE.Mesh;
  private readonly shieldAura: THREE.Mesh;
  private scaleYImpulse = 0;
  private scaleImpulseDecayRate = 12;
  private landingPoseTimer = 0;
  private landingPoseStrength = 0;
  private speedBoostTimer = 0;
  private speedBoostStrength = 1;
  private doubleJumpCharges = 0;
  private doubleJumpPulse = 0;
  private shieldCount = 0;
  private shieldPulse = 0;
  public readonly bodyMaterial: THREE.MeshStandardMaterial;

  constructor() {
    this.mesh.add(this.visualRoot);

    this.automaton = createWindUpAutomaton();
    this.bodyMaterial = this.automaton.bodyMaterial;
    this.visualRoot.add(this.automaton.group);

    const auraGeo = new THREE.TorusGeometry(0.48, 0.05, 8, 18);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0x6ee7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.position.y = 0.5;
    aura.rotation.x = Math.PI / 2;
    aura.visible = false;
    aura.userData.skipTopDownShadowCaster = true;
    this.doubleJumpAura = aura;
    this.visualRoot.add(aura);

    const shieldGeo = new THREE.SphereGeometry(0.45, 24, 16);
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const shieldAura = new THREE.Mesh(shieldGeo, shieldMat);
    shieldAura.position.y = 0.44;
    shieldAura.visible = false;
    shieldAura.userData.skipTopDownShadowCaster = true;
    this.shieldAura = shieldAura;
    this.visualRoot.add(shieldAura);
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
      this.landingPoseTimer = 0;
      this.landingPoseStrength = 0;
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
    const jumpLift = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(this.velocity.y / 12, 0, 1), 0, 1);
    const jumpPose = jumpLift * 0.05;

    if (this.landingPoseTimer > 0) {
      this.landingPoseTimer = Math.max(0, this.landingPoseTimer - dt);
    }
    const landingT = this.landingPoseStrength > 0 && this.landingPoseTimer > 0
      ? 1 - this.landingPoseTimer / 0.24
      : 0;
    const landingPose = this.landingPoseStrength > 0 && this.landingPoseTimer > 0
      ? this.landingPoseStrength * (1 - (1 - landingT) * (1 - landingT))
      : 0;
    if (this.landingPoseTimer === 0) {
      this.landingPoseStrength = 0;
    }

    // Feed the body state to the automaton so the feet articulate:
    // toes point down while rising, flatten & splay on landing.
    // While airborne falling (velocity < 0), the feet gently relax back — the
    // jumpAmount dips toward 0, not negative, so we don't double-up with landingPose.
    const jumpAmount = this.onGround
      ? 0
      : this.velocity.y > 0
        ? jumpLift
        : Math.max(0, 1 + verticalVelocityFactor); // fades from 1 (apex) to 0 (fast fall)
    this.automaton.update(dt, {
      jumpAmount,
      landAmount: landingPose,
    });

    const targetScaleY = 1 + airborneScaleY + this.scaleYImpulse + jumpPose - landingPose * 0.08;
    const targetScaleXZ = 1 - (targetScaleY - 1) * 0.55;
    const scaleLerp = 1 - Math.exp(-dt * 18);
    this.visualRoot.scale.x = THREE.MathUtils.lerp(this.visualRoot.scale.x, targetScaleXZ, scaleLerp);
    this.visualRoot.scale.y = THREE.MathUtils.lerp(this.visualRoot.scale.y, targetScaleY, scaleLerp);
    this.visualRoot.scale.z = THREE.MathUtils.lerp(this.visualRoot.scale.z, targetScaleXZ, scaleLerp);
    this.scaleYImpulse = THREE.MathUtils.lerp(this.scaleYImpulse, 0, 1 - Math.exp(-dt * this.scaleImpulseDecayRate));
    // Recover normal decay rate once the impulse has settled (bouncy launches use a
    // slower decay for the prolonged stretch; normal jumps use the default).
    if (Math.abs(this.scaleYImpulse) < 0.02 && this.scaleImpulseDecayRate !== 12) {
      this.scaleImpulseDecayRate = 12;
    }

    const targetLean = THREE.MathUtils.clamp(-move.x * 0.16, -0.16, 0.16);
    this.visualRoot.rotation.z = THREE.MathUtils.lerp(
      this.visualRoot.rotation.z,
      targetLean,
      1 - Math.exp(-dt * 10)
    );
    const targetPitch = jumpLift > 0 ? -jumpLift * 0.08 : landingPose * 0.16;
    this.visualRoot.rotation.x = THREE.MathUtils.lerp(
      this.visualRoot.rotation.x,
      targetPitch,
      1 - Math.exp(-dt * 12)
    );
    const targetYOffset = jumpPose * 0.22 - landingPose * 0.18;
    this.visualRoot.position.y = THREE.MathUtils.lerp(
      this.visualRoot.position.y,
      targetYOffset,
      1 - Math.exp(-dt * 14)
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

    const shieldMaterial = this.shieldAura.material as THREE.MeshBasicMaterial;
    if (this.shieldCount > 0) {
      this.shieldPulse += dt * 3.8;
      this.shieldAura.visible = true;
      const baseOpacity = 0.18 + Math.min(this.shieldCount, 9) * 0.04;
      const targetOpacity = baseOpacity + Math.sin(this.shieldPulse) * 0.07;
      shieldMaterial.opacity = THREE.MathUtils.lerp(shieldMaterial.opacity, targetOpacity, 1 - Math.exp(-dt * 6));
      this.shieldAura.scale.setScalar(1 + Math.sin(this.shieldPulse * 0.9) * 0.05);
      this.shieldAura.rotation.y += dt * 0.8;
      this.shieldAura.rotation.z += dt * 0.4;
    } else {
      this.shieldPulse = 0;
      shieldMaterial.opacity = THREE.MathUtils.lerp(shieldMaterial.opacity, 0, 1 - Math.exp(-dt * 5));
      if (shieldMaterial.opacity < 0.01) {
        this.shieldAura.visible = false;
        shieldMaterial.opacity = 0;
        this.shieldAura.scale.setScalar(1);
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
    this.scaleImpulseDecayRate = 12;
    this.landingPoseTimer = 0.24;
    this.landingPoseStrength = THREE.MathUtils.clamp(impactSpeed * 0.018, 0.45, 1);
  }

  // Visual boost for launches off bouncy gears: stronger stretch (~1.45× effective peak
  // vs ~1.25× for a normal jump) with a slower decay so the spring motion reads clearly.
  // Playful archetype — ease-out-back feel, ~250ms.
  bouncyLaunch() {
    this.scaleYImpulse = 0.5;
    this.scaleImpulseDecayRate = 5;
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

  setShieldCount(count: number) {
    this.shieldCount = count;
    if (count === 0) {
      this.shieldPulse = 0;
    }
  }

  reset(y = 0, z = 0) {
    this.mesh.position.set(0, y, z);
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    this.highestY = y;
    this.prevY = y;
    this.scaleYImpulse = 0;
    this.scaleImpulseDecayRate = 12;
    this.landingPoseTimer = 0;
    this.landingPoseStrength = 0;
    this.speedBoostTimer = 0;
    this.speedBoostStrength = 1;
    this.doubleJumpCharges = 0;
    this.doubleJumpPulse = 0;
    this.visualRoot.scale.setScalar(1);
    this.visualRoot.rotation.set(0, 0, 0);
    this.visualRoot.position.set(0, 0, 0);
    this.resetVisuals();
    this.doubleJumpAura.visible = false;
    this.doubleJumpAura.scale.setScalar(1);
    const auraMaterial = this.doubleJumpAura.material as THREE.MeshBasicMaterial;
    auraMaterial.opacity = 0;
    this.shieldCount = 0;
    this.shieldPulse = 0;
    this.shieldAura.visible = false;
    this.shieldAura.scale.setScalar(1);
    const shieldMaterial = this.shieldAura.material as THREE.MeshBasicMaterial;
    shieldMaterial.opacity = 0;
  }
}
