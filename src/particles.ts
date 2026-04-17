import * as THREE from "three";
import { Gear } from "./gear";

type ParticleKind = "dust" | "spark" | "ambient" | "steam";

type Particle = {
  active: boolean;
  drag: number;
  gravity: number;
  kind: ParticleKind;
  life: number;
  maxLife: number;
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
};

export class ParticleSystem {
  public readonly group = new THREE.Group();

  private readonly particles: Particle[] = [];
  private readonly sharedGeometry = new THREE.IcosahedronGeometry(1, 0);
  private readonly color = new THREE.Color();
  private readonly scale = new THREE.Vector3();
  private readonly spawnCenter = new THREE.Vector3();
  private readonly sparkPosition = new THREE.Vector3();

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
        kind: "dust",
        life: 0,
        maxLife: 0,
        mesh,
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

  update(dt: number, playerPosition: THREE.Vector3) {
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

      particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * dt));
      particle.velocity.y -= particle.gravity * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);

      const material = particle.mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        const fade = 1 - particle.life / particle.maxLife;
        material.opacity = particle.kind === "steam" ? fade * 0.55 : fade;
      }
    }
  }

  spawnLandingDust(position: THREE.Vector3) {
    const count = 3 + Math.floor(Math.random() * 3);
    for (let index = 0; index < count; index += 1) {
      const particle = this.acquire();
      if (!particle) {
        return;
      }

      particle.kind = "dust";
      particle.life = 0;
      particle.maxLife = 0.3;
      particle.drag = 2.2;
      particle.gravity = 3.5;
      particle.mesh.visible = true;
      particle.mesh.position.set(
        position.x + (Math.random() - 0.5) * 0.45,
        position.y + 0.08,
        position.z + (Math.random() - 0.5) * 0.45
      );
      particle.velocity.set((Math.random() - 0.5) * 1.8, 0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 1.8);
      this.scale.setScalar(0.08 + Math.random() * 0.08);
      particle.mesh.scale.copy(this.scale);
      this.setMaterial(particle, 0xd8b38a, 0.75);
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

  private acquire(): Particle | null {
    for (const particle of this.particles) {
      if (!particle.active) {
        particle.active = true;
        return particle;
      }
    }

    return null;
  }

  private setMaterial(particle: Particle, colorHex: number, opacity: number) {
    const material = particle.mesh.material;
    if (!(material instanceof THREE.MeshBasicMaterial)) {
      return;
    }

    this.color.setHex(colorHex);
    material.color.copy(this.color);
    material.opacity = opacity;
  }
}
