import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BORE_Y } from '@/weapons/sniper';
import { weaponMat } from '@/weapons/materials';
import { acogGroup } from '@/weapons/groups';

// ACOG carbine: shorter barrel + handguard, compact prism housing on a
// single cantilever base (authentic ACOG mounting), glowing fiber strip.
{
    const aBarrelGeo = new THREE.CylinderGeometry(0.024, 0.02, 0.95, 32);
    aBarrelGeo.rotateX(Math.PI / 2);
    const aBarrel = new THREE.Mesh(aBarrelGeo, weaponMat);
    aBarrel.position.set(0, BORE_Y, -0.55);
    aBarrel.layers.set(1);
    acogGroup.add(aBarrel);

    const aBrakeGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.08, 24);
    aBrakeGeo.rotateX(Math.PI / 2);
    const aBrake = new THREE.Mesh(aBrakeGeo, weaponMat);
    aBrake.position.set(0, BORE_Y, -1.05);
    aBrake.layers.set(1);
    acogGroup.add(aBrake);

    const guard = new THREE.Mesh(
        new RoundedBoxGeometry(0.08, 0.1, 0.45, 2, 0.01),
        weaponMat,
    );
    guard.position.set(0, -0.15, -0.32);
    guard.layers.set(1);
    acogGroup.add(guard);

    const aRecv = new THREE.Mesh(
        new RoundedBoxGeometry(0.075, 0.16, 0.6, 2, 0.01),
        weaponMat,
    );
    aRecv.position.set(0, -0.225, 0.2);
    aRecv.layers.set(1);
    acogGroup.add(aRecv);

    const aRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.015, 0.4),
        weaponMat,
    );
    aRail.position.set(0, -0.1375, 0.05);
    aRail.layers.set(1);
    acogGroup.add(aRail);

    const aMag = new THREE.Mesh(
        new RoundedBoxGeometry(0.06, 0.09, 0.12, 2, 0.008),
        weaponMat,
    );
    aMag.position.set(0, -0.34, 0.15);
    aMag.layers.set(1);
    acogGroup.add(aMag);

    const aTrig = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.035, 0.014),
        weaponMat,
    );
    aTrig.position.set(0, -0.315, 0.32);
    aTrig.layers.set(1);
    acogGroup.add(aTrig);

    // Prism housing + ocular/objective cups (optic axis stays y = 0 so ADS
    // stays centered for both rifles)
    const housing = new THREE.Mesh(
        new RoundedBoxGeometry(0.062, 0.075, 0.24, 2, 0.008),
        weaponMat,
    );
    housing.position.set(0, 0, 0);
    housing.layers.set(1);
    acogGroup.add(housing);

    const aOcuGeo = new THREE.CylinderGeometry(0.038, 0.034, 0.06, 32, 1, true);
    aOcuGeo.rotateX(Math.PI / 2);
    const aOcu = new THREE.Mesh(aOcuGeo, weaponMat);
    aOcu.position.set(0, 0, 0.14);
    aOcu.layers.set(1);
    acogGroup.add(aOcu);

    const aObjGeo = new THREE.CylinderGeometry(0.036, 0.044, 0.06, 32, 1, true);
    aObjGeo.rotateX(Math.PI / 2);
    const aObj = new THREE.Mesh(aObjGeo, weaponMat);
    aObj.position.set(0, 0, -0.14);
    aObj.layers.set(1);
    acogGroup.add(aObj);

    // Single cantilever mount base (ACOGs don't use two rings)
    const aBase = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.0925, 0.18),
        weaponMat,
    );
    aBase.position.set(0, -0.08375, 0);
    aBase.layers.set(1);
    acogGroup.add(aBase);

    // Fiber-optic light collector strip (signature ACOG glow)
    const fiberMat = new THREE.MeshStandardMaterial({
        color: 0x330000,
        emissive: 0xff2211,
        emissiveIntensity: 1.4,
        roughness: 0.3,
    });
    const fiberGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.1, 12);
    fiberGeo.rotateX(Math.PI / 2);
    const fiber = new THREE.Mesh(fiberGeo, fiberMat);
    fiber.position.set(0, 0.046, 0.02);
    fiber.layers.set(1);
    acogGroup.add(fiber);
}
