import * as THREE from "three";
import { Input } from "./input";

export class Player {
  public mesh = new THREE.Group();
  public velocity = new THREE.Vector3();
  public onGround = false;
  private radius = 0.3;
  private height = 0.6;
  public highestY = 0;

  constructor() {
    // Body
    const bodyGeo = new THREE.CylinderGeometry(this.radius, this.radius, this.height, 12);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xcd7f32, // Bronze
      metalness: 0.9,
      roughness: 0.22
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = this.height / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    this.mesh.add(body);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 6,
      metalness: 0.1,
      roughness: 0.15
    });

    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.1, 0.45, 0.25);
    leftEye.castShadow = true;
    this.mesh.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.1, 0.45, 0.25);
    rightEye.castShadow = true;
    this.mesh.add(rightEye);
  }

  update(dt: number, input: Input) {
    const move = input.getMovement();
    const speed = 5;

    // Movement relative to world
    this.mesh.position.x += move.x * speed * dt;
    this.mesh.position.z += move.y * speed * dt; // move.y is -1 for up, so it moves towards -z

    // Gravity
    if (!this.onGround) {
      this.velocity.y -= 20 * dt;
    } else {
      this.velocity.y = 0;
    }

    // Jump
    if (this.onGround && input.justPressed("space")) {
      this.velocity.y = 8;
      this.onGround = false;
    }

    this.mesh.position.y += this.velocity.y * dt;

    if (this.mesh.position.y > this.highestY) {
        this.highestY = this.mesh.position.y;
    }

    // Look in movement direction
    if (Math.abs(move.x) > 0.1 || Math.abs(move.y) > 0.1) {
      const angle = Math.atan2(move.x, move.y);
      this.mesh.rotation.y = angle;
    }
  }

  reset(y = 0) {
    this.mesh.position.set(0, y, 0);
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    this.highestY = y;
  }
}
