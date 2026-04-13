import * as THREE from "three";

export class Gear {
  public mesh: THREE.Group;
  public radius: number;
  public height: number;
  public rotationSpeed: number;
  public rotationDir: number;

  constructor(radius = 1.5, height = 0.3, rotationSpeed = 0.5, color = 0x8b4513) {
    this.radius = radius;
    this.height = height;
    this.rotationSpeed = rotationSpeed;
    this.rotationDir = Math.random() > 0.5 ? 1 : -1;

    this.mesh = new THREE.Group();

    // Gear body
    const bodyGeo = new THREE.CylinderGeometry(radius, radius, height, 32);
    const bodyMat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.9,
      roughness: 0.28
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);

    // Teeth
    const toothGeo = new THREE.BoxGeometry(0.2, height, 0.4);
    const toothMat = bodyMat.clone();
    const toothCount = Math.floor(radius * 10);
    for (let i = 0; i < toothCount; i++) {
      const angle = (i / toothCount) * Math.PI * 2;
      const tooth = new THREE.Mesh(toothGeo, toothMat);
      tooth.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      tooth.rotation.y = -angle;
      tooth.castShadow = true;
      tooth.receiveShadow = true;
      this.mesh.add(tooth);
    }
  }

  update(dt: number) {
    this.mesh.rotation.y += this.rotationSpeed * this.rotationDir * dt;
  }

  checkCollision(playerPos: THREE.Vector3, playerRadius: number): { onGear: boolean, y: number, momentum: THREE.Vector3 } {
    const distSq = (playerPos.x - this.mesh.position.x) ** 2 + (playerPos.z - this.mesh.position.z) ** 2;
    const combinedRadius = this.radius + 0.1; // small margin
    
    // Player bottom check (playerPos.y is the bottom of the cylinder)
    // We check if player is within the vertical bounds of the gear top surface with a small tolerance
    const gearTop = this.mesh.position.y + this.height/2;
    const isAbove = playerPos.y >= gearTop - 0.2 && playerPos.y <= gearTop + 0.2;
    
    if (distSq < combinedRadius * combinedRadius && isAbove) {
        // Calculate momentum inherited from rotation (cross product of omega and r)
        const dx = playerPos.x - this.mesh.position.x;
        const dz = playerPos.z - this.mesh.position.z;
        const radialVel = this.rotationSpeed * this.rotationDir;
        const momentum = new THREE.Vector3(-dz * radialVel, 0, dx * radialVel);

        return { onGear: true, y: gearTop, momentum };
    }

    return { onGear: false, y: 0, momentum: new THREE.Vector3() };
  }
}
