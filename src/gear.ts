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
      color: new THREE.Color(color).multiplyScalar(0.82),
      metalness: 0.9,
      roughness: 0.34
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);

    const topSurfaceGeo = new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, 0.05, 32);
    const topSurfaceMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).offsetHSL(0.02, 0.12, 0.18),
      emissive: new THREE.Color(color).multiplyScalar(0.18),
      emissiveIntensity: 0.8,
      metalness: 0.78,
      roughness: 0.22
    });
    const topSurface = new THREE.Mesh(topSurfaceGeo, topSurfaceMat);
    topSurface.position.y = height / 2 + 0.03;
    topSurface.castShadow = true;
    topSurface.receiveShadow = true;
    this.mesh.add(topSurface);

    const landingRingGeo = new THREE.TorusGeometry(Math.max(radius * 0.72, 0.6), Math.max(radius * 0.06, 0.08), 10, 40);
    const landingRingMat = new THREE.MeshStandardMaterial({
      color: 0xffcf8e,
      emissive: 0xffb14a,
      emissiveIntensity: 1.3,
      metalness: 0.55,
      roughness: 0.3
    });
    const landingRing = new THREE.Mesh(landingRingGeo, landingRingMat);
    landingRing.rotation.x = Math.PI / 2;
    landingRing.position.y = height / 2 + 0.05;
    landingRing.castShadow = true;
    landingRing.receiveShadow = true;
    this.mesh.add(landingRing);

    const hubGeo = new THREE.CylinderGeometry(radius * 0.22, radius * 0.22, height + 0.04, 16);
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0x2b2623,
      emissive: 0x150f0a,
      emissiveIntensity: 0.9,
      metalness: 0.92,
      roughness: 0.26
    });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.y = 0.01;
    hub.castShadow = true;
    hub.receiveShadow = true;
    this.mesh.add(hub);

    const spokeGeo = new THREE.BoxGeometry(radius * 1.15, 0.08, Math.max(radius * 0.1, 0.16));
    const spokeMat = new THREE.MeshStandardMaterial({
      color: 0xf6b86f,
      emissive: 0xffa43c,
      emissiveIntensity: 1,
      metalness: 0.72,
      roughness: 0.24
    });
    const spokeCount = 3;
    for (let i = 0; i < spokeCount; i++) {
      const spoke = new THREE.Mesh(spokeGeo, spokeMat);
      spoke.position.y = height / 2 + 0.065;
      spoke.rotation.y = (i / spokeCount) * Math.PI * 2 + Math.PI / 8;
      spoke.castShadow = true;
      spoke.receiveShadow = true;
      this.mesh.add(spoke);
    }

    const markerGeo = new THREE.BoxGeometry(Math.max(radius * 0.26, 0.2), 0.12, Math.max(radius * 0.1, 0.14));
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0x9ef5ff,
      emissive: 0x58e1ff,
      emissiveIntensity: 2.2,
      metalness: 0.4,
      roughness: 0.18
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(radius * 0.55, height / 2 + 0.08, 0);
    marker.castShadow = true;
    this.mesh.add(marker);

    // Teeth
    const toothGeo = new THREE.BoxGeometry(0.2, height, 0.4);
    const toothMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.95),
      emissive: new THREE.Color(color).multiplyScalar(0.08),
      emissiveIntensity: 0.65,
      metalness: 0.88,
      roughness: 0.24
    });
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
