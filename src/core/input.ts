import * as THREE from 'three';
import type { LeanKey, MoveKey } from '@/state/store';
import {
    CRESCENT_NAMES,
    CRESCENT_POWERS,
    EYEBOX_NAMES,
    MIRROR_BRIGHT,
    MIRROR_DIM,
    RETICLE_GREEN,
    RETICLE_RED,
    S,
    SWAY_MODE_NAMES,
    batteryOn,
    config,
    keys,
    leanKeys,
} from '@/state/store';
import { lensMat, scopeCamera } from '@/optics/scopeRig';
import {
    applyBattery,
    setOpticMode,
    startReload,
    tryFire,
} from '@/state/actions';
import { applySwayUI, els, setUiVisible, updateAmmoUI } from '@/ui/hud';

const blocker = document.getElementById('blocker') as HTMLDivElement;
blocker.addEventListener('click', () => {
    void document.body.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
    blocker.style.display =
    document.pointerLockElement === document.body ? 'none' : 'flex';
});

document.addEventListener('mousemove', (event: MouseEvent) => {
    if (document.pointerLockElement !== document.body) return;
    const movementX = event.movementX || 0;
    const movementY = event.movementY || 0;

    const baseSens = 0.002;
    const fovRatio = S.isAiming ? config.fov / 70.0 : 1.0;
    const currentSens = S.isAiming ? baseSens * fovRatio * 1.5 : baseSens;

    S.yawTarget -= movementX * currentSens;
    S.pitchTarget = THREE.MathUtils.clamp(
        S.pitchTarget - movementY * currentSens,
        -Math.PI / 2,
        Math.PI / 2,
    );
    S.moveImpX += movementX;
    S.moveImpY += movementY;

    // The weapon's physical lag is driven by the RAW mouse impulse, not the
    // zoom-scaled view sensitivity — a rifle has the same inertia at any
    // magnification. Scaling by fovRatio here left the ADS lag ~20x too small,
    // which is why no eye relief showed while tracking at high zoom.
    S.mouseVelocityX += movementX * 0.001;
    S.mouseVelocityY += movementY * 0.001;
});

document.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 2) S.isAiming = true;
    if (e.button === 0) {
        S.triggerHeld = true;
        tryFire();
    }
});
document.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button === 0) S.triggerHeld = false;
});
document.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button === 2) S.isAiming = false;
});
document.addEventListener('contextmenu', (e: Event) => e.preventDefault());

document.addEventListener('wheel', (e: WheelEvent) => {
    if (S.isAiming) {
        config.fov += Math.sign(e.deltaY) * 0.5;
        config.fov = THREE.MathUtils.clamp(config.fov, 1.0, 15.0);
        scopeCamera.fov = config.fov;
        scopeCamera.updateProjectionMatrix();
    }
});

function isMoveKey(key: string): key is MoveKey {
    return key === 'w' || key === 'a' || key === 's' || key === 'd';
}
function isLeanKey(key: string): key is LeanKey {
    return key === 'q' || key === 'e';
}
// H toggles the whole #ui text banner (clean screenshots / videos).
// Hidden by default — only the "press H" hint pill shows until toggled.
let uiVisible = false;
document.addEventListener('keydown', (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (isMoveKey(k)) keys[k] = true;
    if (isLeanKey(k)) leanKeys[k] = true;
    if (k === '1') setOpticMode(false);
    if (k === '2') setOpticMode(true);
    if (k === 'c') {
        S.reticleIsGreen = !S.reticleIsGreen
        ;(lensMat.uniforms.uReticleColor.value as THREE.Color).copy(
            S.reticleIsGreen ? RETICLE_GREEN : RETICLE_RED,
        );
    }
    if (k === 'b') {
        const key = S.acogActive ? 'acog' : 'sniper';
        batteryOn[key] = batteryOn[key] > 0.5 ? 0 : 1;
        applyBattery();
    }
    if (k === 'f') {
        S.ffpEnabled = !S.ffpEnabled;
    }
    if (k === 'v') {
        S.fireAuto = !S.fireAuto;
        updateAmmoUI();
    }
    if (k === 't') {
        S.dofRings = !S.dofRings;
        lensMat.uniforms.uDofRings.value = S.dofRings ? 1.0 : 0.0;
    }
    if (k === 'k') {
        S.rightEye = !S.rightEye;
        els.eye.textContent = `Sight: ${S.rightEye ? 'RIGHT-EYE' : 'CENTERED'} — K to toggle`;
    }
    if (k === 'g') {
        S.eyeBoxMode = (S.eyeBoxMode % 3) + 1;
        els.box.textContent = `Eye-box hold: ${EYEBOX_NAMES[S.eyeBoxMode]} — G cycles`;
    }
    if (k === 'z') {
        S.zoomSwayOnly = !S.zoomSwayOnly;
        els.zoom.textContent = `Zoom blacken: ${S.zoomSwayOnly ? 'SWAY-ONLY (rest mild)' : 'FULL (rest blackens)'} — Z toggles`;
    }
    if (k === 'x') {
        S.swayMode = (S.swayMode + 1) % SWAY_MODE_NAMES.length;
        applySwayUI();
    }
    if (k === 'n') {
        S.crescentOpposite = !S.crescentOpposite;
        lensMat.uniforms.uCrescentSide.value = S.crescentOpposite ? 1.0 : -1.0;
        els.cres.textContent = `Crescent side: ${S.crescentOpposite ? 'OPPOSITE drift' : 'FOLLOW drift'} — N toggles`;
    }
    if (k === 'h') {
        uiVisible = !uiVisible;
        setUiVisible(uiVisible);
    }
    if (k === 'p') {
        S.crescentPowerIdx = (S.crescentPowerIdx + 1) % CRESCENT_NAMES.length;
        lensMat.uniforms.uCrescentPower.value = CRESCENT_POWERS[S.crescentPowerIdx];
        els.crespower.textContent = `Crescent power: ${CRESCENT_NAMES[S.crescentPowerIdx]} — P cycles`;
    }
    if (k === 'o') {
        S.mirrorBright = !S.mirrorBright;
        lensMat.uniforms.uMirrorBoost.value = S.mirrorBright
            ? MIRROR_BRIGHT
            : MIRROR_DIM;
        els.outline.textContent = `Mirror: ${S.mirrorBright ? 'BRIGHT (infinite-mirror)' : 'DIM (dark bore)'} — O toggles`;
    }
    if (k === 'r') startReload();
    if (k === 'shift') S.breathHeld = true;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (isMoveKey(k)) keys[k] = false;
    if (isLeanKey(k)) leanKeys[k] = false;
    if (k === 'shift') {
        if (S.breathHeld) S.gaspT = 0.6; // release shudder: the chest gasps back
        S.breathHeld = false;
    }
});
