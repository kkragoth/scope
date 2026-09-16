import * as THREE from 'three';
import {
    ACOG_FOV,
    FIRE_GAP_AUTO,
    FIRE_GAP_SINGLE,
    RELOAD_TIME,
    S,
    SNIPER_FOV,
    _eyeSm,
    batteryOn,
    config,
    curAmmo,
    curMag,
    setCurAmmo,
} from '@/state/store';
import { camera } from '@/core/boot';
import { wRotVel, wVel, weaponGroup } from '@/core/player';
import { BORE_Y, tubeLength } from '@/weapons/sniper';
import { acogGroup, sniperGroup } from '@/weapons/groups';
import { lensMat, scopeCamera } from '@/optics/scopeRig';
import {
    _bFwd,
    _bRight,
    _bUp,
    _brassP,
    _brassQ,
    _mzl,
    flashSprite,
    nextBrass,
} from '@/weapons/effects';
import { updateAmmoUI } from '@/ui/hud';

function applyBattery(): void {
    lensMat.uniforms.uBattery.value = batteryOn[S.acogActive ? 'acog' : 'sniper'];
}
function setOpticMode(acog: boolean): void {
    lensMat.uniforms.uOpticMode.value = acog ? 1.0 : 0.0;
    // Swap whole rifle models, not just reticles
    sniperGroup.visible = !acog;
    acogGroup.visible = acog;
    S.acogActive = acog;
    applyBattery();
    config.fov = acog ? ACOG_FOV : SNIPER_FOV;
    scopeCamera.fov = config.fov;
    // Objective station differs per housing (sniper bell vs ACOG cup)
    scopeCamera.position.z = acog ? -0.14 : -(tubeLength / 2);
    scopeCamera.updateProjectionMatrix();
    // Fresh shoulder weld for the swapped optic: the eye geometry of the two
    // rifles differs, so a leftover eye-box crescent / swing-speed state from
    // the old optic must not ride along into the new sight picture.
    _eyeSm.set(0, 0);
    S._reliefSm = 1.0;
    S._swaySpeed = 0.0;
    S.freeOX = 0;
    S.freeOY = 0;
    S.bodyLX = 0;
    S.bodyLY = 0;
    S.bodyRX = 0;
    S._crossEyeX = 0;
    S._crossEyeY = 0;
    sniperGroup.position.set(0, 0, 0);
    acogGroup.position.set(0, 0, 0);
    sniperGroup.rotation.set(0, 0, 0);
    acogGroup.rotation.set(0, 0, 0);
    lensMat.uniforms.uEyeOffset.value.set(0, 0);
    lensMat.uniforms.uEyeRelief.value = 1.0;
    lensMat.uniforms.uSwaySpeed.value = 0.0
    ;(lensMat.uniforms.uReticleOffset.value as THREE.Vector2).set(0, 0);
    updateAmmoUI();
}
function startReload(): void {
    if (S.reloadT > 0 || curAmmo() === curMag()) return;
    S.reloadT = RELOAD_TIME;
    updateAmmoUI();
}
function tryFire(): void {
    if (document.pointerLockElement !== document.body) return;
    if (S.reloadT > 0 || S.fireCd > 0) return;
    if (curAmmo() <= 0) {
        startReload();
        return;
    }
    const auto = S.acogActive && S.fireAuto;
    setCurAmmo(curAmmo() - 1);
    S.fireCd = auto ? FIRE_GAP_AUTO : FIRE_GAP_SINGLE;
    S.flashT = 0.06;
    S.triggerPull = 1;
    // Recoil straight into the springs. Auto runs lighter per shot — the stack
    // climbs through the springs naturally on a held trigger.
    const rk = auto ? 0.45 : 1.0;
    wRotVel.x += 2.4 * rk;
    wRotVel.y += (Math.random() - 0.5) * 0.7 * rk;
    wRotVel.z += (Math.random() - 0.5) * 0.5 * rk;
    wVel.z += 1.15 * rk;
    wVel.x += (Math.random() - 0.5) * 0.15 * rk;
    // head takes a touch of it too + FOV punch (existing lerp settles it)
    S.pitchTarget = Math.min(S.pitchTarget + 0.014, Math.PI / 2);
    S.yawTarget += (Math.random() - 0.5) * 0.006;
    camera.fov = Math.min(camera.fov + 2.5, 75);
    // flash at the brake tip
    _mzl.set(0, BORE_Y, -1.45);
    weaponGroup.localToWorld(_mzl);
    flashSprite.position.copy(_mzl);
    flashSprite.scale.setScalar(0.28 + Math.random() * 0.16);
    flashSprite.material.rotation = Math.random() * Math.PI;
    flashSprite.material.opacity = 1;
    flashSprite.visible = true;
    // brass out the right side of the action
    weaponGroup.getWorldQuaternion(_brassQ);
    _bRight.set(1, 0, 0).applyQuaternion(_brassQ);
    _bUp.set(0, 1, 0).applyQuaternion(_brassQ);
    _bFwd.set(0, 0, -1).applyQuaternion(_brassQ);
    _brassP.set(0.07, -0.19, 0.12);
    weaponGroup.localToWorld(_brassP);
    const b = nextBrass();
    b.active = true;
    b.life = 2.5;
    b.m.visible = true;
    b.m.position.copy(_brassP);
    b.vel
        .copy(_bRight)
        .multiplyScalar(1.4 + Math.random() * 0.5)
        .addScaledVector(_bUp, 2.0 + Math.random())
        .addScaledVector(_bFwd, -0.4);
    b.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    updateAmmoUI();
}
export { applyBattery, setOpticMode, startReload, tryFire };
