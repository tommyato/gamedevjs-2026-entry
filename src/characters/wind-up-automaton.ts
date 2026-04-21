import * as THREE from "three";

export type WindUpAutomaton = {
  group: THREE.Group;
  update: (dt: number) => void;
};

export function createWindUpAutomaton(): WindUpAutomaton {
  const group = new THREE.Group();

  // Body - brass/copper cylinder capsule
  const bodyRadius = 0.3;
  const bodyHeight = 0.9;
  const bodyGeo = new THREE.CapsuleGeometry(bodyRadius, bodyHeight - 2 * bodyRadius, 12, 8);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xb8823a, // aged brass
    metalness: 0.8,
    roughness: 0.35,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = bodyHeight / 2;
  group.add(body);

  // Head - slightly smaller sphere/rounded cube
  const headRadius = 0.22;
  const headGeo = new THREE.SphereGeometry(headRadius, 16, 12);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xc89440, // brighter brass
    metalness: 0.8,
    roughness: 0.35,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = bodyHeight + headRadius * 0.8;
  group.add(head);

  // Glowing eyes (warm amber/white)
  const eyeGeo = new THREE.SphereGeometry(0.04, 8, 8);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffd98a,
    emissive: 0xffd98a,
    emissiveIntensity: 1.8,
    metalness: 0.1,
    roughness: 0.15,
  });

  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.08, bodyHeight + headRadius * 0.8, headRadius * 0.8);
  group.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.08, bodyHeight + headRadius * 0.8, headRadius * 0.8);
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

  // Key handle - T-shaped (two lobes)
  const handleGeo = new THREE.TorusGeometry(0.08, 0.02, 8, 12);
  const keyHandle = new THREE.Mesh(handleGeo, keyMat);
  keyHandle.position.z = -0.09;
  keyHandle.rotation.x = Math.PI / 2;
  keyGroup.add(keyHandle);

  // Position key on the back
  keyGroup.position.set(0, bodyHeight / 2, -bodyRadius - 0.09);
  group.add(keyGroup);

  // Arms - stubby capsule arms
  const armRadius = 0.08;
  const armLength = 0.3;
  const armGeo = new THREE.CapsuleGeometry(armRadius, armLength - 2 * armRadius, 6, 4);
  const armMat = new THREE.MeshStandardMaterial({
    color: 0xb8823a,
    metalness: 0.8,
    roughness: 0.35,
  });

  const leftArm = new THREE.Mesh(armGeo, armMat);
  leftArm.position.set(-bodyRadius - 0.05, bodyHeight * 0.7, 0);
  leftArm.rotation.z = Math.PI / 6;
  group.add(leftArm);

  const rightArm = new THREE.Mesh(armGeo, armMat);
  rightArm.position.set(bodyRadius + 0.05, bodyHeight * 0.7, 0);
  rightArm.rotation.z = -Math.PI / 6;
  group.add(rightArm);

  // Legs - short cylindrical legs
  const legRadius = 0.1;
  const legHeight = 0.25;
  const legGeo = new THREE.CylinderGeometry(legRadius, legRadius * 0.8, legHeight, 8);
  const legMat = new THREE.MeshStandardMaterial({
    color: 0xb8823a,
    metalness: 0.8,
    roughness: 0.35,
  });

  const leftLeg = new THREE.Mesh(legGeo, legMat);
  leftLeg.position.set(-bodyRadius * 0.4, legHeight / 2, 0);
  group.add(leftLeg);

  const rightLeg = new THREE.Mesh(legGeo, legMat);
  rightLeg.position.set(bodyRadius * 0.4, legHeight / 2, 0);
  group.add(rightLeg);

  // Optional: Gear detail on chest
  const gearGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.03, 8);
  const gearMat = new THREE.MeshStandardMaterial({
    color: 0x8a5a22,
    metalness: 0.9,
    roughness: 0.3,
  });
  const gearDetail = new THREE.Mesh(gearGeo, gearMat);
  gearDetail.position.set(0, bodyHeight * 0.5, bodyRadius + 0.01);
  gearDetail.rotation.x = Math.PI / 2;
  group.add(gearDetail);

  // Animation state
  let keyRotation = 0;
  const keyRotationSpeed = 0.3; // rad/sec

  const update = (dt: number) => {
    keyRotation += keyRotationSpeed * dt;
    keyGroup.rotation.z = keyRotation;
  };

  return { group, update };
}
