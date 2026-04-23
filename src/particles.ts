import * as THREE from "three";
import { Gear, type GearVariant } from "./gear";

type ParticleKind = "dust" | "spark" | "ambient" | "steam" | "confetti" | "magnet" | "trail";

type Particle = {
  active: boolean;
  drag: number;
  gravity: number;
  initialScale: THREE.Vector3;
  kind: ParticleKind;
  life: number;
  maxLife: number;
  magnetAnchor: THREE.Vector3;
  magnetAngularVelocity: number;
  magnetAngle: number;
  magnetRadius: number;
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
};

export class ParticleSystem {
  public readonly group = new THREE.Group();

  private readonly particles: Particle[] = [];
  private readonly sharedGeometry = new THREE.IcosahedronGeometry(1, 0);
  private readonly trailGeometry = new THREE.RingGeometry(0.42, 1.0, 32);
  private readonly trailColorStart = new THREE.Color(0xcaa25a); // brass/gold
  private readonly trailColorEnd = new THREE.Color(0xfff4d8);   // warm white
  private readonly color = new THREE.Color();
  private readonly scale = new THREE.Vector3();
  private readonly spawnCenter = new THREE.Vector3();
  private readonly sparkPosition = new THREE.Vector3();
  private readonly upVector = new THREE.Vector3(0, 1, 0);

  private readonly landingColors: Record<GearVariant, number> = {
    normal: 0xff9548,
    speed: 0xff9548,
    wind: 0x67c7ff,
    magnetic: 0xc074ff,
    bouncy: 0x68f08a,
    crumbling: 0xff9f5d,
    reverse: 0xffa64a,
    piston: 0xffc94a,
    milestone: 0xffd700,
  };

  private readonly confettiColors = [0xffd35e, 0x67c7ff, 0xc074ff, 0x68f08a, 0xff8e2b, 0xffffff];

  constructor(maxParticles: number) {
    for (let index = 0; index < maxParticles; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.sharedGeometry, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.particles.push({
        active: false,
        drag: 0,
        gravity: 0,
        initialScale: new THREE.Vector3(),
        kind: "dust",
        life: 0,
        maxLife: 0,
        mesh,
        magnetAnchor: new THREE.Vector3(),
        magnetAngularVelocity: 0,
        magnetAngle: 0,
        magnetRadius: 0,
        velocity: new THREE.Vector3(),
      });
    }
  }

  reset() {
    for (const particle of this.particles) {
      particle.active = false;
      particle.mesh.visible = false;
      particle.life = 0;
    }
  }

  update(dt: number, playerPosition: THREE.Vector3, camera: THREE.Camera) {
    for (const particle of this.particles) {
      if (!particle.active) {
        continue;
      }

      particle.life += dt;
      if (particle.life >= particle.maxLife) {
        particle.active = false;
        particle.mesh.visible = false;
        continue;
      }

      if (particle.kind === "magnet") {
        const t = THREE.MathUtils.clamp(particle.life / particle.maxLife, 0, 1);
        const fade = 1 - t;
        const spiralAngle = particle.magnetAngle + particle.magnetAngularVelocity * particle.life;
        const spiralRadius = particle.magnetRadius * Math.max(0, Math.pow(fade, 1.1));
        particle.mesh.position.set(
          particle.magnetAnchor.x + Math.cos(spiralAngle) * spiralRadius,
          particle.magnetAnchor.y + fade * 0.02,
          particle.magnetAnchor.z + Math.sin(spiralAngle) * spiralRadius
        );
        const material = particle.mesh.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = fade * 0.92;
        }
        continue;
      }

      particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * dt));
      particle.velocity.y -= particle.gravity * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);

      const material = particle.mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        const t = particle.life / particle.maxLife;
        const fade = 1 - t;
        if (particle.kind === "trail") {
          // Rings contract inward: scale lerps from initial down to 0.02
          const currentScale = THREE.MathUtils.lerp(particle.initialScale.x, 0.02, t);
          particle.mesh.scale.setScalar(currentScale);
          // Fade in from 0.3 to peak 0.85 at t=0.2, then fade out to 0 by end
          const fadeIn = Math.min(t / 0.2, 1.0);
          const fadeOut = 1.0 - Math.pow(Math.max((t - 0.2) / 0.8, 0), 1.5);
          material.opacity = fadeIn * fadeOut * 0.85;
          // Color lerp: brass/gold → warm white over lifetime
          material.color.lerpColors(this.trailColorStart, this.trailColorEnd, t);
          // Orient horizontally (cylinder slice) — ring lies flat in XZ plane
          particle.mesh.rotation.set(Math.PI / 2, 0, 0);
        } else if (particle.kind === "steam") {
          material.opacity = fade * 0.55;
        } else {
          material.opacity = fade;
        }
      }
    }
  }

  spawnMagnetPull(gearPos: { x: number; y: number; z: number }, radius: number) {
    const count = 4 + Math.floor(Math.random() * 3);
    const height = gearPos.y + 0.11;
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      const angle = Math.random() * Math.PI * 2;
      const edgeRadius = radius * (0.96 + Math.random() * 0.08);
      const life = 0.6 + Math.random() * 0.2;
      const swirlDirection = Math.random() > 0.5 ? 1 : -1;

      particle.kind = "magnet";
      particle.life = 0;
      particle.maxLife = life;
      particle.drag = 0;
      particle.gravity = 0;
      particle.mesh.visible = true;
      particle.magnetAnchor.set(gearPos.x, height, gearPos.z);
      particle.magnetAngle = angle;
      particle.magnetRadius = edgeRadius;
      particle.magnetAngularVelocity = swirlDirection * (3.2 + Math.random() * 1.6);
      particle.mesh.position.set(
        gearPos.x + Math.cos(angle) * edgeRadius,
        height,
        gearPos.z + Math.sin(angle) * edgeRadius
      );
      this.scale.setScalar(0.08 + Math.random() * 0.04);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, 0xc074ff, 0.9);
    }
  }

  spawnLandingSparks(position: THREE.Vector3, variant: GearVariant, landingSpeed: number) {
    const impactSpeed = Math.abs(landingSpeed);
    const count = THREE.MathUtils.clamp(8 + Math.floor(impactSpeed * 0.9), 8, 15);
    const color = this.landingColors[variant] ?? this.landingColors.normal;
    const speedScale = 1 + Math.min(impactSpeed * 0.08, 1.5);

    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.22 + Math.random() * 0.14;
      particle.drag = 1.3 + Math.random() * 0.4;
      particle.gravity = 2.2 + Math.random() * 0.8;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.3,
        position.y + 0.08,
        position.z + (Math.random() - 0.5) * 0.3
      );
      const theta = Math.random() * Math.PI * 2;
      const radial = 1.2 + Math.random() * 1.8;
      const upward = 1.25 + Math.random() * 0.9;
      particle.velocity.set(
        Math.cos(theta) * radial * speedScale,
        upward * speedScale,
        Math.sin(theta) * radial * speedScale
      );
      particle.velocity.addScaledVector(this.upVector, Math.max(0.2, impactSpeed * 0.02));
      this.scale.set(0.04 + Math.random() * 0.035, 0.04 + Math.random() * 0.035, 0.08 + Math.random() * 0.06);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, color, 0.95);
    }
  }

  spawnGearBonkSparks(position: THREE.Vector3, impactSpeed: number) {
    const strength = Math.max(0, impactSpeed);
    const count = THREE.MathUtils.clamp(4 + Math.floor(strength * 0.45), 4, 8);
    const color = strength > 8 ? 0xffd05a : 0xff9548;
    const speedScale = 0.6 + Math.min(strength * 0.08, 1);

    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.18 + Math.random() * 0.08;
      particle.drag = 1.55 + Math.random() * 0.35;
      particle.gravity = 2.6 + Math.random() * 0.8;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.28,
        position.y - 0.02,
        position.z + (Math.random() - 0.5) * 0.28
      );
      const theta = Math.random() * Math.PI * 2;
      const radial = 0.7 + Math.random() * 1.1;
      const upward = 0.6 + Math.random() * 0.45;
      particle.velocity.set(
        Math.cos(theta) * radial * speedScale,
        upward * speedScale,
        Math.sin(theta) * radial * speedScale
      );
      particle.velocity.y -= 0.25;
      this.scale.set(0.035 + Math.random() * 0.02, 0.035 + Math.random() * 0.02, 0.08 + Math.random() * 0.04);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, color, 0.95);
    }
  }

  spawnComboFireworks(position: THREE.Vector3, multiplier: number) {
    const count = 8 + Math.min(multiplier - 1, 7);
    const color = multiplier >= 7 ? 0xdde8ff : multiplier >= 4 ? 0xffd700 : 0xcd7f32;

    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.4 + Math.random() * 0.2;
      particle.drag = 0.9 + Math.random() * 0.3;
      particle.gravity = 1.8 + Math.random() * 0.8;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.6,
        position.y + 0.5,
        position.z + (Math.random() - 0.5) * 0.6
      );
      const theta = Math.random() * Math.PI * 2;
      const radial = 0.8 + Math.random() * 1.4;
      const upward = 3.5 + Math.random() * 2.0;
      particle.velocity.set(Math.cos(theta) * radial, upward, Math.sin(theta) * radial);
      this.scale.setScalar(0.045 + Math.random() * 0.03);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, color, 0.95);
    }
  }

  spawnMilestoneConfetti(position: THREE.Vector3) {
    const count = 20 + Math.floor(Math.random() * 11);
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "confetti";
      particle.life = 0;
      particle.maxLife = 0.95 + Math.random() * 0.45;
      particle.drag = 0.7 + Math.random() * 0.25;
      particle.gravity = 1.4 + Math.random() * 0.5;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.8,
        position.y + 0.35 + Math.random() * 0.45,
        position.z + (Math.random() - 0.5) * 0.8
      );
      particle.velocity.set(
        (Math.random() - 0.5) * 3.2,
        1.8 + Math.random() * 2.4,
        (Math.random() - 0.5) * 3.2
      );
      this.scale.set(0.05 + Math.random() * 0.04, 0.02 + Math.random() * 0.03, 0.05 + Math.random() * 0.04);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, this.confettiColors[Math.floor(Math.random() * this.confettiColors.length)], 0.95);
    }
  }

  spawnWindGust(gearPosition: THREE.Vector3, gearRadius: number, windAngle: number) {
    // Emit particles from the gear surface that streak in the wind direction,
    // making it obvious the platform is blowing air.
    const count = 5;
    for (let index = 0; index < count; index++) {
      const particle = this.acquire();
      if (!particle) return;

      // Spawn scattered across gear top surface
      const spawnAngle = Math.random() * Math.PI * 2;
      const spawnRadius = Math.random() * gearRadius * 0.9;
      particle.kind = "dust";
      particle.life = 0;
      particle.maxLife = 0.45 + Math.random() * 0.3;
      particle.drag = 0.55;
      particle.gravity = -0.2;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        gearPosition.x + Math.cos(spawnAngle) * spawnRadius,
        gearPosition.y + 0.14 + Math.random() * 0.22,
        gearPosition.z + Math.sin(spawnAngle) * spawnRadius
      );

      // Stream in wind direction with slight angular spread
      const speed = 2.8 + Math.random() * 1.6;
      const spread = (Math.random() - 0.5) * 0.45;
      particle.velocity.set(
        Math.cos(windAngle + spread) * speed,
        0.15 + Math.random() * 0.25,
        Math.sin(windAngle + spread) * speed
      );

      // Elongated in travel direction, blue-white tint
      this.scale.set(0.028 + Math.random() * 0.018, 0.022, 0.065 + Math.random() * 0.04);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, Math.random() > 0.4 ? 0xaaddff : 0xddf4ff, 0.8);
    }
  }

  spawnDeathBurst(position: THREE.Vector3) {
    const count = 12 + Math.floor(Math.random() * 5); // 12–16
    const colors = [0xcd7f32, 0xb87333, 0xa67c52];
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "dust";
      particle.life = 0;
      particle.maxLife = 0.6 + Math.random() * 0.3;
      particle.drag = 1.5;
      particle.gravity = 8;
      particle.mesh.visible = true;
      particle.mesh.position.copy(position);
      particle.mesh.position.y += 0.3;

      // Spread outward in a sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 3 + Math.random() * 2;
      particle.velocity.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.abs(Math.cos(phi)) * speed + 1,
        Math.sin(phi) * Math.sin(theta) * speed
      );

      this.scale.setScalar(0.06 + Math.random() * 0.06);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, colors[Math.floor(Math.random() * colors.length)], 0.9);
    }
  }

  spawnGearSpark(gear: Gear) {
    const particle = this.acquire();
    if (!particle) {
      return;
    }

    const angle = Math.random() * Math.PI * 2;
    const angularVelocity = gear.getAngularVelocity();
    if (angularVelocity === 0) {
      particle.active = false;
      particle.mesh.visible = false;
      return;
    }

    const gearPosition = gear.getPosition(this.sparkPosition);
    particle.kind = "spark";
    particle.life = 0;
    particle.maxLife = 0.24;
    particle.drag = 1.2;
    particle.gravity = -1.5;
    particle.mesh.visible = true;
    particle.mesh.position.set(
      gearPosition.x + Math.cos(angle) * gear.radius,
      gear.getTopY() + 0.04,
      gearPosition.z + Math.sin(angle) * gear.radius
    );
    particle.velocity.set(
      -Math.sin(angle) * angularVelocity * gear.radius * 0.9,
      0.4 + Math.random() * 0.6,
      Math.cos(angle) * angularVelocity * gear.radius * 0.9
    );
    this.scale.set(0.05, 0.05, 0.12);
    particle.mesh.scale.copy(this.scale);
    this.setMaterial(particle, 0xff9548, 0.9);
  }

  spawnJumpSparks(position: THREE.Vector3) {
    const count = 3 + Math.floor(Math.random() * 3);
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.3;
      particle.drag = 1.8;
      particle.gravity = 4.2;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.22,
        position.y + 0.05,
        position.z + (Math.random() - 0.5) * 0.22
      );
      particle.velocity.set(
        (Math.random() - 0.5) * 0.75,
        1.8 + Math.random() * 0.8,
        (Math.random() - 0.5) * 0.75
      );
      this.scale.setScalar(0.045 + Math.random() * 0.02);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, Math.random() > 0.5 ? 0xffd05a : 0xff8e2b, 0.95);
    }
  }

  spawnJumpSteam(position: THREE.Vector3) {
    const count = 4 + Math.floor(Math.random() * 3);
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "steam";
      particle.life = 0;
      particle.maxLife = 0.5 + Math.random() * 0.3;
      particle.drag = 0.8;
      particle.gravity = -0.4;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.15,
        position.y + 0.05,
        position.z + (Math.random() - 0.5) * 0.15
      );
      particle.velocity.set(
        (Math.random() - 0.5) * 0.4,
        0.6 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.4
      );
      this.scale.setScalar(0.2 + Math.random() * 0.1);
      particle.mesh.scale.copy(this.scale);
      // Warm white with brass undertone
      this.setMaterial(particle, Math.random() > 0.6 ? 0xf5e9d4 : 0xc7a271, 0.6);
    }
  }

  spawnBrassLandingSparks(position: THREE.Vector3) {
    const count = 3 + Math.floor(Math.random() * 2);
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.3;
      particle.drag = 1.6;
      particle.gravity = 5.0;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.18,
        position.y + 0.03,
        position.z + (Math.random() - 0.5) * 0.18
      );
      particle.velocity.set(
        (Math.random() - 0.5) * 1.0,
        1.2 + Math.random() * 0.6,
        (Math.random() - 0.5) * 1.0
      );
      this.scale.setScalar(0.035 + Math.random() * 0.015);
      particle.mesh.scale.copy(this.scale);
      // Bright yellow-orange fade
      this.setMaterial(particle, Math.random() > 0.5 ? 0xffc96b : 0xff8a2a, 0.9);
    }
  }

  spawnIceCrystals(position: THREE.Vector3, radius: number) {
    const count = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const particle = this.acquire();
      if (!particle) return;

      const angle = Math.random() * Math.PI * 2;
      const r = radius * (0.5 + Math.random() * 0.5);
      particle.kind = "spark";
      particle.life = 0;
      particle.maxLife = 0.55 + Math.random() * 0.35;
      particle.drag = 0.4 + Math.random() * 0.3;
      particle.gravity = -0.3;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + Math.cos(angle) * r,
        position.y + 0.1 + Math.random() * 0.2,
        position.z + Math.sin(angle) * r
      );
      particle.velocity.set(
        (Math.random() - 0.5) * 0.45,
        0.15 + Math.random() * 0.35,
        (Math.random() - 0.5) * 0.45
      );
      this.scale.setScalar(0.035 + Math.random() * 0.03);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, Math.random() > 0.4 ? 0x88ccff : 0xeef8ff, 0.88);
    }
  }

  spawnSteamPuff(position: THREE.Vector3) {
    const particle = this.acquire();
    if (!particle) {
      return;
    }

    particle.kind = "steam";
    particle.life = 0;
    particle.maxLife = 3 + Math.random() * 1.2;
    particle.drag = 0.18;
    particle.gravity = -0.28;
    particle.mesh.visible = true;
    particle.mesh.position.set(
      position.x + (Math.random() - 0.5) * 1.8,
      position.y + (Math.random() - 0.5) * 0.6,
      position.z + (Math.random() - 0.5) * 1.8
    );
    particle.velocity.set(
      (Math.random() - 0.5) * 0.14,
      0.35 + Math.random() * 0.22,
      (Math.random() - 0.5) * 0.14
    );
    this.scale.setScalar(0.08 + Math.random() * 0.08);
    particle.mesh.scale.copy(this.scale);
    this.setMaterial(particle, 0xd8d4cf, 0.32);
  }

  spawnTrailWisp(position: THREE.Vector3) {
    // Cap active trail wisps at 40 to bound memory/draw cost
    let activeTrailCount = 0;
    for (const p of this.particles) {
      if (p.active && p.kind === "trail") {
        activeTrailCount += 1;
      }
    }
    if (activeTrailCount >= 40) {
      return;
    }

    const particle = this.acquire();
    if (!particle) {
      return;
    }

    // Slight lateral jitter so wisps don't form a stiff line
    const jitterX = (Math.random() - 0.5) * 0.1;
    const jitterZ = (Math.random() - 0.5) * 0.1;

    particle.kind = "trail";
    particle.life = 0;
    particle.maxLife = 0.85 + Math.random() * 0.1;
    particle.drag = 0.05;
    particle.gravity = 0;
    particle.mesh.visible = true;
    particle.mesh.geometry = this.trailGeometry;
    particle.mesh.position.set(position.x + jitterX, position.y, position.z + jitterZ);

    // Drift upward at ~0.4 u/s in world space — anchored, player moves past them
    particle.velocity.set(0, 0.4, 0);

    // Large enough to read at gameplay camera distance; rings shrink inward over life.
    const baseScale = 0.2 + Math.random() * 0.08;
    this.scale.setScalar(baseScale);
    particle.mesh.scale.copy(this.scale);
    particle.initialScale.copy(this.scale);

    this.setMaterial(particle, 0xcaa25a, 0.9, THREE.AdditiveBlending, THREE.DoubleSide);
  }

  private acquire(): Particle | null {
    for (const particle of this.particles) {
      if (!particle.active) {
        particle.active = true;
        // Reset geometry to shared default; trail spawner overrides below
        particle.mesh.geometry = this.sharedGeometry;
        return particle;
      }
    }

    return null;
  }

  private setMaterial(
    particle: Particle,
    colorHex: number,
    opacity: number,
    blending: THREE.Blending = THREE.NormalBlending,
    side: THREE.Side = THREE.FrontSide
  ) {
    const material = particle.mesh.material;
    if (!(material instanceof THREE.MeshBasicMaterial)) {
      return;
    }

    this.color.setHex(colorHex);
    material.color.copy(this.color);
    material.opacity = opacity;
    if (material.blending !== blending) {
      material.blending = blending;
      material.needsUpdate = true;
    }
    if (material.side !== side) {
      material.side = side;
      material.needsUpdate = true;
    }
  }
}
