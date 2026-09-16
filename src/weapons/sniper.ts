import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { weaponGroup } from '@/core/player';
import { scopeMat, weaponMat } from '@/weapons/materials';

// ---- Rifle: full-length barrel, receiver block, ring-mounted scope ----
// Bore line sits below the optic axis; barrel runs the whole rifle length
// and seats into the receiver. Scope rides on top on two ring mounts.
const BORE_Y = -0.125;

// Scope main tube (optic axis at y = 0)
const tubeRadius = 0.052;
const tubeLength = 0.45;
const tubeGeo = new THREE.CylinderGeometry(
    tubeRadius,
    tubeRadius,
    tubeLength,
    64,
    1,
    true,
);
tubeGeo.rotateX(Math.PI / 2);
const scopeTube = new THREE.Mesh(tubeGeo, scopeMat);
scopeTube.layers.set(1);
weaponGroup.add(scopeTube);

// Objective bell (wider toward the front/-Z)
const objBellGeo = new THREE.CylinderGeometry(0.054, 0.064, 0.1, 48, 1, true);
objBellGeo.rotateX(Math.PI / 2);
const objBell = new THREE.Mesh(objBellGeo, scopeMat);
objBell.position.set(0, 0, -0.255);
objBell.layers.set(1);
weaponGroup.add(objBell);

// Ocular bell (wider toward the eye/+Z, lens stays visible through it).
// Kept short and slim so its interior reads as a thin rim at ADS,
// not a thick black ring around the sight picture.
const ocuBellGeo = new THREE.CylinderGeometry(0.056, 0.053, 0.06, 48, 1, true);
ocuBellGeo.rotateX(Math.PI / 2);
const ocuBell = new THREE.Mesh(ocuBellGeo, scopeMat);
ocuBell.position.set(0, 0, 0.235);
ocuBell.layers.set(1);
weaponGroup.add(ocuBell);

// Turrets: elevation on top, windage on the right
const elevGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
const elevation = new THREE.Mesh(elevGeo, scopeMat);
elevation.position.set(0, 0.068, 0.03);
elevation.layers.set(1);
weaponGroup.add(elevation);
const windGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.035, 24);
windGeo.rotateZ(Math.PI / 2);
const windage = new THREE.Mesh(windGeo, scopeMat);
windage.position.set(0.068, 0, 0.03);
windage.layers.set(1);
weaponGroup.add(windage);

// Receiver: rectangular block below the barrel (edges eased — catches sky
// highlights instead of razor CG edges; same tri-count class, baked once)
const receiverGeo = new RoundedBoxGeometry(0.075, 0.16, 0.9, 2, 0.01);
const receiver = new THREE.Mesh(receiverGeo, weaponMat);
receiver.position.set(0, -0.225, 0.05);
receiver.layers.set(1);
weaponGroup.add(receiver);

// Magazine + trigger blade
const magGeo = new RoundedBoxGeometry(0.06, 0.09, 0.12, 2, 0.008);
const magazine = new THREE.Mesh(magGeo, weaponMat);
magazine.position.set(0, -0.34, -0.05);
magazine.layers.set(1);
weaponGroup.add(magazine);
const triggerGeo = new THREE.BoxGeometry(0.012, 0.035, 0.014);
const trigger = new THREE.Mesh(triggerGeo, weaponMat);
trigger.position.set(0, -0.315, 0.12);
trigger.layers.set(1);
weaponGroup.add(trigger);

// Bolt handle + knob on the right side of the receiver
const boltArmGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 16);
boltArmGeo.rotateZ(Math.PI / 2);
const boltArm = new THREE.Mesh(boltArmGeo, weaponMat);
boltArm.position.set(0.06, -0.195, 0.18);
boltArm.layers.set(1);
weaponGroup.add(boltArm);
const boltKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 16, 12),
    weaponMat,
);
boltKnob.position.set(0.088, -0.195, 0.18);
boltKnob.layers.set(1);
weaponGroup.add(boltKnob);

// Barrel: heavy tapered profile, breech seated inside the receiver,
// running the whole length out to the muzzle brake
const barrelGeo = new THREE.CylinderGeometry(0.028, 0.022, 1.7, 32);
barrelGeo.rotateX(Math.PI / 2);
const gunBarrel = new THREE.Mesh(barrelGeo, weaponMat);
gunBarrel.position.set(0, BORE_Y, -0.5);
gunBarrel.layers.set(1);
weaponGroup.add(gunBarrel);

// Muzzle brake at the tip
const brakeGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.12, 24);
brakeGeo.rotateX(Math.PI / 2);
const muzzleBrake = new THREE.Mesh(brakeGeo, weaponMat);
muzzleBrake.position.set(0, BORE_Y, -1.38);
muzzleBrake.layers.set(1);
weaponGroup.add(muzzleBrake);
// Scope rail on top of the receiver
const railGeo = new THREE.BoxGeometry(0.04, 0.015, 0.5);
const rail = new THREE.Mesh(railGeo, weaponMat);
rail.position.set(0, -0.1375, 0);
rail.layers.set(1);
weaponGroup.add(rail);

// Two ring mounts (columns): post + torus ring around the tube
const RING_Z = [0.13, -0.13];
for (const rz of RING_Z) {
    const postGeo = new THREE.BoxGeometry(0.034, 0.078, 0.04);
    const post = new THREE.Mesh(postGeo, weaponMat);
    post.position.set(0, -0.091, rz);
    post.layers.set(1);
    weaponGroup.add(post);

    const ringGeo = new THREE.TorusGeometry(0.0545, 0.0075, 12, 48);
    const ring = new THREE.Mesh(ringGeo, weaponMat);
    ring.position.set(0, 0, rz);
    ring.layers.set(1);
    weaponGroup.add(ring);
}

export { BORE_Y, tubeRadius, tubeLength, boltArm, boltKnob, trigger };
