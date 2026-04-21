import * as THREE from "three";

export type WindUpAutomaton = {
  group: THREE.Group;
  update: (dt: number) => void;
};

export function createWindUpAutomaton(): WindUpAutomaton {
  const group = new THREE.Group();

  // Body — plain brass cylinder (no capsule, no gear chest detail)
  const bodyRadius = 0.3;
  const bodyHeight = 0.9;
  const bodyY = 0.55; // raised to leave room for feet below

  const bodyGeo = new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 20, 1);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xb8823a, // aged brass
    metalness: 0.8,
    roughness: 0.35,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = bodyY;
  group.add(body);

  // Glowing amber eyes — embedded in upper front of cylinder
  const eyeGeo = new THREE.SphereGeometry(0.045, 8, 8);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffd98a,
    emissive: 0xffd98a,
    emissiveIntensity: 1.8,
    metalness: 0.1,
    roughness: 0.15,
  });

  const eyeY = bodyY + bodyHeight * 0.28;
  const eyeZ = bodyRadius * 0.88; // slightly inside front surface for embedded look

  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.085, eyeY, eyeZ);
  group.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.085, eyeY, eyeZ);
  group.add(rightEye);

  // Feet — flat coin-shaped discs, darker bronze, symmetrical under body
  const footRadius = 0.15;
  const footHeight = 0.07;
  const footGeo = new THREE.CylinderGeometry(footRadius, footRadius, footHeight, 16);
  const footMat = new THREE.MeshStandardMaterial({
    color: 0x6b4422, // dark bronze
    metalness: 0.85,
    roughness: 0.4,
  });

  const footY = footHeight / 2; // sits flat on ground plane

  const leftFoot = new THREE.Mesh(footGeo, footMat);
  leftFoot.position.set(-0.1, footY, 0);
  group.add(leftFoot);

  const rightFoot = new THREE.Mesh(footGeo, footMat);
  rightFoot.position.set(0.1, footY, 0);
  group.add(rightFoot);

  // Front button — decorative brass rivet/push-button at chest height
  const buttonGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12);
  const buttonMat = new THREE.MeshStandardMaterial({
    color: 0xffcc44, // polished bright brass
    emissive: 0xaa7700,
    emissiveIntensity: 0.25,
    metalness: 0.95,
    roughness: 0.15,
  });
  const button = new THREE.Mesh(buttonGeo, buttonMat);
  button.rotation.x = Math.PI / 2; // axis points forward so flat face faces viewer
  button.position.set(0, bodyY - bodyHeight * 0.05, bodyRadius + 0.02);
  group.add(button);

  // Wind-up key on the back (signature feature — unchanged)
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
