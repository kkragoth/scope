import * as THREE from 'three';
import { weaponGroup } from '@/core/player';
// Side-effect import: the sniper parts must exist on weaponGroup before the
// adopt loop below moves them under sniperGroup.
import '@/weapons/sniper';

// ---- Optic assemblies: sniper rifle vs ACOG carbine ----
// Everything built above belongs to the sniper rifle; move it under
// sniperGroup so keys 1/2 can swap whole models, not just reticles.
const sniperGroup = new THREE.Group();
const acogGroup = new THREE.Group();
weaponGroup.add(sniperGroup, acogGroup);
for (const m of [...weaponGroup.children]) {
    if (m !== sniperGroup && m !== acogGroup) sniperGroup.add(m);
}
acogGroup.visible = false;

export { sniperGroup, acogGroup };
