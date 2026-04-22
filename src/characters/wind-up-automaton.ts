import * as THREE from "three";

export type WindUpAutomatonPose = {
  // -1..1: negative = squash/land (feet splay out, flat), positive = jump/rise (feet tuck, point down)
  jumpAmount: number;
  // 0..1: landing pose strength — flattens feet against ground and spreads them slightly
  landAmount: number;
};

export type WindUpAutomatonKeyState = {
  color: THREE.ColorRepresentation;
  emissive: THREE.ColorRepresentation;
  emissiveIntensity: number;
};

export type WindUpAutomaton = {
  group: THREE.Group;
  update: (dt: number, pose?: WindUpAutomatonPose) => void;
  bodyMaterial: THREE.MeshStandardMaterial;
  keyMaterial: THREE.MeshStandardMaterial;
  keyDefaultColor: number;
  setKeyState: (state: WindUpAutomatonKeyState) => void;
};

export function createWindUpAutomaton(): WindUpAutomaton {
  const group = new THREE.Group();

  // Feet — flat coin-shaped discs, darker bronze, symmetrical under body.
  // Sit flush on the ground plane; body rests on top of them. We wrap each
  // foot in a pivot group so we can tilt them (toes-down on jump, splay on
  // landing) without disturbing their resting position.
  const footRadius = 0.15;
  const footHeight = 0.07;
  const footGeo = new THREE.CylinderGeometry(footRadius, footRadius, footHeight, 16);
  const footMat = new THREE.MeshStandardMaterial({
    color: 0x6b4422, // dark bronze
    metalness: 0.85,
    roughness: 0.4,
  });
  const footY = footHeight / 2;

  const leftFootPivot = new THREE.Group();
  leftFootPivot.position.set(-0.12, footY, 0);
  const leftFoot = new THREE.Mesh(footGeo, footMat);
  leftFootPivot.add(leftFoot);
  group.add(leftFootPivot);

  const rightFootPivot = new THREE.Group();
  rightFootPivot.position.set(0.12, footY, 0);
  const rightFoot = new THREE.Mesh(footGeo, footMat);
  rightFootPivot.add(rightFoot);
  group.add(rightFootPivot);

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
  const KEY_DEFAULT_COLOR = 0xc8a14a;
  const keyMat = new THREE.MeshStandardMaterial({
    color: KEY_DEFAULT_COLOR, // brass — driven externally to signal powerup state
    emissive: 0x000000,
    emissiveIntensity: 0,
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
  let currentFootPitch = 0; // rotation.x on the foot pivots
  let currentFootSplay = 0; // outward tilt on rotation.z
  let currentFootLift = 0;  // y lift from resting, positive during jump tuck
  let currentFootScaleY = 1; // flatten during landing

  const restingFootY = footY;

  const update = (dt: number, pose?: WindUpAutomatonPose) => {
    keyRotation += keyRotationSpeed * dt;
    keyGroup.rotation.z = keyRotation;

    const jump = pose ? THREE.MathUtils.clamp(pose.jumpAmount, -1, 1) : 0;
    const land = pose ? THREE.MathUtils.clamp(pose.landAmount, 0, 1) : 0;

    // Target feet posture:
    //  - jump > 0  → toes point down (pitch forward around x), feet tucked up slightly
    //  - land > 0  → feet flatten (scaleY < 1) and splay outward (rotation.z)
    const targetPitch = jump > 0 ? jump * 0.9 : 0;
    const targetLift = jump > 0 ? jump * 0.08 : 0;
    const targetSplay = land * 0.35;
    const targetScaleY = 1 - land * 0.45;

    // Critically-damped-ish smoothing keeps the motion eased rather than snappy.
    const pitchLerp = 1 - Math.exp(-dt * 16);
    const liftLerp  = 1 - Math.exp(-dt * 14);
    const splayLerp = 1 - Math.exp(-dt * 18);
    const scaleLerp = 1 - Math.exp(-dt * 18);

    currentFootPitch  = THREE.MathUtils.lerp(currentFootPitch,  targetPitch,  pitchLerp);
    currentFootLift   = THREE.MathUtils.lerp(currentFootLift,   targetLift,   liftLerp);
    currentFootSplay  = THREE.MathUtils.lerp(currentFootSplay,  targetSplay,  splayLerp);
    currentFootScaleY = THREE.MathUtils.lerp(currentFootScaleY, targetScaleY, scaleLerp);

    leftFootPivot.rotation.x  = currentFootPitch;
    rightFootPivot.rotation.x = currentFootPitch;
    leftFootPivot.rotation.z  =  currentFootSplay;
    rightFootPivot.rotation.z = -currentFootSplay;
    leftFootPivot.position.y  = restingFootY + currentFootLift;
    rightFootPivot.position.y = restingFootY + currentFootLift;
    leftFoot.scale.y  = currentFootScaleY;
    rightFoot.scale.y = currentFootScaleY;
  };

  const setKeyState = (state: WindUpAutomatonKeyState) => {
    keyMat.color.set(state.color);
    keyMat.emissive.set(state.emissive);
    keyMat.emissiveIntensity = state.emissiveIntensity;
  };

  return {
    group,
    update,
    bodyMaterial: bodyMat,
    keyMaterial: keyMat,
    keyDefaultColor: KEY_DEFAULT_COLOR,
    setKeyState,
  };
}
