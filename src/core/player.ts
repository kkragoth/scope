import * as THREE from 'three';
import { camera, scene } from '@/core/boot';

const playerGroup = new THREE.Group();
playerGroup.position.y = 2;
scene.add(playerGroup);

const pitchObject = new THREE.Group();
playerGroup.add(pitchObject);
pitchObject.add(camera);
camera.layers.enable(1);
const weaponGroup = new THREE.Group();
pitchObject.add(weaponGroup);
const hipPosition = new THREE.Vector3(0.22, -0.22, -0.65);
const adsPosition = new THREE.Vector3(0.0, 0.0, -0.38);
weaponGroup.position.copy(hipPosition);

// WHOLE-WEAPON PHYSICS: position/rotation + velocities. Anchors switch on
// intent; the gun flies there with mass (slightly underdamped → a breath of
// overshoot on the shoulder). ADS weight is DERIVED from gun position.
const wPos = hipPosition.clone();
const wVel = new THREE.Vector3();
const wRot = new THREE.Vector3(0, 0.15, 0.05);
const wRotVel = new THREE.Vector3();
const HIP_ADS_DIST = hipPosition.distanceTo(adsPosition);

export {
    playerGroup,
    pitchObject,
    weaponGroup,
    hipPosition,
    adsPosition,
    HIP_ADS_DIST,
    wPos,
    wVel,
    wRot,
    wRotVel,
};
