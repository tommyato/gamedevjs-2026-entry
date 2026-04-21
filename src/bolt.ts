import * as THREE from "three";
import { Gear } from "./gear";

export class BoltCollectible {
  public readonly mesh = new THREE.Group();

  private readonly gear: Gear;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private available = true;
  private collectTimer = 0;
  private readonly hoverPhase = Math.random() * Math.PI * 2;

  constructor(gear: Gear) {
    this.gear = gear;

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffd765,
      emissive: 0xffc13b,
      emissiveIntensity: 0.6,
      metalness: 0.82,
      roughness: 0.22,
      transparent: true,
      opacity: 1,
    });
    const coreMaterial = new THREE.MeshStandardMaterial({
      color: 0xfff0a4,
      emissive: 0xffd45d,
      emissiveIntensity: 0.7,
      metalness: 0.55,
      roughness: 0.18,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(bodyMaterial, coreMaterial);

    const shaftGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6);
    const shaft = new THREE.Mesh(shaftGeo, bodyMaterial);
    shaft.rotation.z = Math.PI / 2;
    this.mesh.add(shaft);

    const headGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 6);
    const headLeft = new THREE.Mesh(headGeo, bodyMaterial);
    headLeft.position.x = -0.22;
    headLeft.rotation.z = Math.PI / 2;
    this.mesh.add(headLeft);

    const headRight = new THREE.Mesh(headGeo, bodyMaterial);
    headRight.position.x = 0.22;
    headRight.rotation.z = Math.PI / 2;
    this.mesh.add(headRight);

    const coreGeo = new THREE.TorusGeometry(0.16, 0.05, 8, 16);
    const core = new THREE.Mesh(coreGeo, coreMaterial);
    core.rotation.y = Math.PI / 2;
    this.mesh.add(core);
  }

  update(dt: number, elapsedTime: number) {
    if (this.available) {
      const bob = Math.sin(elapsedTime * 2.4 + this.hoverPhase) * 0.12;
      const gearPosition = this.gear.getPosition();
      this.mesh.position.set(gearPosition.x, this.gear.getTopY() + 0.75 + bob, gearPosition.z);
      this.mesh.rotation.y += dt * 1.8;
      return;
    }

    this.collectTimer += dt;
    const progress = Math.min(this.collectTimer / 0.22, 1);
    const scale = 1 + Math.sin(progress * Math.PI) * 0.45;
    this.mesh.scale.setScalar(scale);
    for (const material of this.materials) {
      material.opacity = 1 - progress;
    }

    if (progress >= 1) {
      this.mesh.visible = false;
    }
  }

  tryCollect(playerPosition: THREE.Vector3): boolean {
    if (!this.available || !this.mesh.visible) {
      return false;
    }

    const dx = playerPosition.x - this.mesh.position.x;
    const dy = playerPosition.y + 0.3 - this.mesh.position.y;
    const dz = playerPosition.z - this.mesh.position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > 0.75 * 0.75) {
      return false;
    }

    this.available = false;
    this.collectTimer = 0;
    return true;
  }

  reset() {
    this.available = true;
    this.collectTimer = 0;
    this.mesh.visible = true;
    this.mesh.scale.setScalar(1);
    for (const material of this.materials) {
      material.opacity = 1;
    }
  }
}
