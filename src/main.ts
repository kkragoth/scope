import './style.css';
// Composition root: import order is evaluation order — builders run first
// (scene → world → weapons → optics), then state/ui/actions/input, then the
// frame loop. Cross-module wiring lives in the modules' import edges.
import '@/world/environment';
import '@/core/player';
import '@/weapons/materials';
import '@/weapons/sniper';
import '@/weapons/groups';
import '@/weapons/acog';
import '@/weapons/effects';
import '@/optics/targets';
import { sizeDofTargets } from '@/optics/dof';
import '@/optics/scopeRig';
import '@/state/store';
import { applySwayUI } from '@/ui/hud';
import '@/state/actions';
import '@/core/input';
import { animate } from '@/core/loop';
import { camera, renderer } from '@/core/boot';

applySwayUI();
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    sizeDofTargets();
});
