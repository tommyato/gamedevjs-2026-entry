import * as THREE from "three";
import { Gear } from "./gear";

type ParticleKind = "dust" | "spark" | "ambient";

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
    let ambientCount = 0;
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

      if (particle.kind === "ambient") {
        ambientCount += 1;
      }

      particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * dt));
      particle.velocity.y -= particle.gravity * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);

      const material = particle.mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 1 - particle.life / particle.maxLife;
      }
    }

    while (ambientCount < 18) {
      if (!this.spawnAmbient(playerPosition)) {
        break;
      }
      ambientCount += 1;
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

  private spawnAmbient(playerPosition: THREE.Vector3): boolean {
    const particle = this.acquire();
    if (!particle) {
      return false;
    }

    particle.kind = "ambient";
    particle.life = 0;
    particle.maxLife = 4 + Math.random() * 3;
    particle.drag = 0.15;
    particle.gravity = -0.12;
    particle.mesh.visible = true;
    this.spawnCenter.copy(playerPosition);
    particle.mesh.position.set(
      this.spawnCenter.x + (Math.random() - 0.5) * 16,
      this.spawnCenter.y - 6 + Math.random() * 18,
      this.spawnCenter.z - 8 + Math.random() * 18
    );
    particle.velocity.set(
      (Math.random() - 0.5) * 0.15,
      0.05 + Math.random() * 0.08,
      (Math.random() - 0.5) * 0.15
    );
    this.scale.setScalar(0.025 + Math.random() * 0.035);
    particle.mesh.scale.copy(this.scale);
    this.setMaterial(particle, 0xbeb7aa, 0.35);
    return true;
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
