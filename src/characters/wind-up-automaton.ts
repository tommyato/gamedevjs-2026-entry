import * as THREE from "three";

export type WindUpAutomaton = {
  group: THREE.Group;
  update: (dt: number) => void;
};

export function createWindUpAutomaton(): WindUpAutomaton {
  const group = new THREE.Group();

  // Feet — flat coin-shaped discs, darker bronze, symmetrical under body.
  // Sit flush on the ground plane; body rests on top of them.
  const footRadius = 0.15;
  const footHeight = 0.07;
  const footGeo = new THREE.CylinderGeometry(footRadius, footRadius, footHeight, 16);
  const footMat = new THREE.MeshStandardMaterial({
    color: 0x6b4422, // dark bronze
    metalness: 0.85,
    roughness: 0.4,
  });
  const footY = footHeight / 2;

  const leftFoot = new THREE.Mesh(footGeo, footMat);
  leftFoot.position.set(-0.12, footY, 0);
  group.add(leftFoot);

  const rightFoot = new THREE.Mesh(footGeo, footMat);
  rightFoot.position.set(0.12, footY, 0);
  group.add(rightFoot);

  // Body — matches the in-game player exactly: cylinder r=0.3, h=0.6, bronze.
  // Raised by footHeight so the body sits on top of the feet instead of clipping them.
  const bodyRadius = 0.3;
  const bodyHeight = 0.6;
  const bodyBottomY = footHeight;
  const bodyY = bodyBottomY + bodyHeight / 2; // center of cylinder

  const bodyGeo = new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 12);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xcd7f32, // bronze — matches player.ts
    metalness: 0.9,
    roughness: 0.22,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = bodyY;
  group.add(body);

  // Eyes — cyan glowing (matches player.ts), but BIGGER (0.08 vs player's 0.05)
  // for the cute doe-eyed sandbox read. Positioned on the upper front of the
  // cylinder with the same relative offsets as the player.
  const eyeRadius = 0.08;
  const eyeGeo = new THREE.SphereGeometry(eyeRadius, 12, 12);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    emissive: 0x00ffff,
    emissiveIntensity: 1.5,
    metalness: 0.1,
    roughness: 0.15,
  });

  // Player eyes sit at (±0.1, 0.45, 0.25) with body.bottom=0. Translate the
  // same relative height (0.45 above body bottom) into our stacked coords.
  const eyeY = bodyBottomY + 0.45;
  const eyeZ = 0.25;

  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.1, eyeY, eyeZ);
  group.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.1, eyeY, eyeZ);
  group.add(rightEye);

  // Wind-up key on the back (signature feature)
  const keyGroup = new THREE.Group();

  // Key shaft
  const keyShaftGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.18, 8);
  const keyMat = new THREE.MeshStandardMaterial({
    color: 0x8a5a22, // darker brass for contrast
    metalness: 0.9,
    roughness: 0.3,
  });
  const keyShaft = new THREE.Mesh(keyShaftGeo, keyMat);
  keyShaft.rotation.x = Math.PI / 2;
  keyGroup.add(keyShaft);

  // Key handle — torus loop
  const handleGeo = new THREE.TorusGeometry(0.08, 0.02, 8, 12);
  const keyHandle = new THREE.Mesh(handleGeo, keyMat);
  keyHandle.position.z = -0.09;
  keyHandle.rotation.x = Math.PI / 2;
  keyGroup.add(keyHandle);

  // Position key on the back at mid-body height
  keyGroup.position.set(0, bodyY, -bodyRadius - 0.09);
  group.add(keyGroup);

  // Animation state
  let keyRotation = 0;
  const keyRotationSpeed = 0.3; // rad/sec

  const update = (dt: number) => {
    keyRotation += keyRotationSpeed * dt;
    keyGroup.rotation.z = keyRotation;
  };

  return { group, update };
}
