import * as THREE from 'three';

// Game-wide mutable state. Plain `export let` scalars cannot be assigned
// through an ES import binding, so every cross-module scalar lives on the
// single mutable holder `S` instead. `const` objects (vectors, key maps,
// config) are mutated in place and need no wrapper.
export interface ScopeConfig {
  fov: number
}

export const config: ScopeConfig = { fov: 3.0 };

export const S = {
    isAiming: false,
    // Eye-box hold mode (G): 1 CLEAN — re-seat fully; 2 SOFT — a small crescent
    // always remains; 3 STICKY — misalignment stays until un-shouldered.
    eyeBoxMode: 1,
    // Zoom blackening response (Z): SWAY-ONLY suppresses eye-box error at rest.
    zoomSwayOnly: true,
    // Crescent side (N): OPPOSITE drift (default) vs FOLLOW drift.
    crescentOpposite: true,
    // Crescent power (P): LOW → MEDIUM → HIGH → EXTREME gain index.
    crescentPowerIdx: 1,
    // White-circle mirror intensity (O): BRIGHT infinite-mirror vs DIM dark bore.
    mirrorBright: true,
    // Weapon sway mode (X cycles 0..5, default 5 BODY+FREE).
    swayMode: 5,
    // FREEAIM aim-lead state (lens UV units): fast attack, slow catch-up.
    freeOX: 0,
    freeOY: 0,
    // BODY physical-lag state (meters) + pitch whisper (up/down only).
    bodyLX: 0,
    bodyLY: 0,
    bodyRX: 0,
    // ZOOM-SHRINK memory: wheeling out melts the eased lead/crescent states now
    // instead of letting stale zoomed-in magnitude ride the slow release.
    prevFreeZoom: 1,
    prevZoomTighten: 1,
    // Right-eye ADS stance (K): scope rides on the dominant-eye side.
    rightEye: true,
    // Cheek-weld spring state: weapon motion smoothed before the shader.
    mouseVelocityX: 0,
    mouseVelocityY: 0,
    // LAYER 1 — head look-intent targets (the head eases, never teleports).
    yawTarget: 0,
    pitchTarget: 0,
    // Per-frame mouse impulse (px): drives acceleration kicks, then zeroed.
    // Raw (unscaled) impulse — a rifle has the same inertia at any magnification.
    moveImpX: 0,
    moveImpY: 0,
    breathHeld: false,
    // Post-hold release shudder timer (the chest gasps back).
    gaspT: 0,
    reticleIsGreen: false,
    // FFP scaling (ACOG reticle grows with zoom) — on by default, F toggles.
    ffpEnabled: true,
    // ACOG SEMI/AUTO toggle (V). Sniper is single-fire only.
    fireAuto: false,
    // Scope-glass rings DOF (T). Default on.
    dofRings: true,
    acogActive: false,
    sniperAmmo: 5,
    acogAmmo: 30,
    triggerHeld: false,
    reloadT: 0,
    fireCd: 0,
    triggerPull: 0,
    flashT: 0,
    // OPERATOR LAG: smoothed eye-vector targets (the eye re-seats slower than
    // geometry moves, so the shadow blooms after a flick, then settles).
    _reliefSm: 1.0,
    _swaySpeed: 0.0,
    // Crosshair-driven eye (modes 3/4/5): exit-pupil crescent keyed to the
    // crosshair's off-centre position, consumed by the NEXT frame's smoothing.
    _crossEyeX: 0,
    _crossEyeY: 0,
    // Applied shoulder-pivot swing (single source of truth for rotation + feed).
    _scopeSwingX: 0,
    _scopeSwingY: 0,
};

export const EYEBOX_NAMES = ['', 'CLEAN', 'SOFT', 'STICKY'] as const;
export const CRESCENT_POWERS = [0.25, 0.5, 0.75, 1.0] as const;
export const CRESCENT_NAMES = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const;
export const MIRROR_DIM = 0.15;
export const MIRROR_BRIGHT = 1.0;
export const SWAY_MODE_NAMES = [
    'FREE',
    'LOCKED',
    'LOCKED+EYE',
    'FREEAIM',
    'BODY',
    'BODY+FREE',
] as const;
export const ADS_X_RIGHT = 0.065;
export const SNIPER_FOV = 3.0;
export const ACOG_FOV = 9.0;
export const RETICLE_RED = new THREE.Color(1.0, 0.16, 0.05);
export const RETICLE_GREEN = new THREE.Color(0.25, 1.0, 0.35);
export const MAG_SNIPER = 5;
export const MAG_ACOG = 30;
export const FIRE_GAP_SINGLE = 0.9;
export const FIRE_GAP_AUTO = 0.12;
export const RELOAD_TIME = 1.4;
// Exit-pupil crescent tuning: max travel + gain from crosshair decentration.
export const CROSS_EYE_MAX = 0.42;
export const CROSS_EYE_GAIN = 1.0;
// SHOULDER PIVOT: whole-rifle lead/body motion rotates about the butt-vs-
// shoulder point so the rear stays planted while the muzzle sweeps the arc.
export const SHOULDER_PIVOT = new THREE.Vector3(0, -0.28, 0.42);
export const SHOULDER_ARM_Z = 0.42;
// Fraction of the reticle lead ALSO swung as barrel (rest stays drawn cross).
export const SHOULDER_LEAD_GAIN = 0.35;
// Extra whip on the shoulder angle: the muzzle sweeps a bigger arc than the
// scope travels. Cap keeps the glass on the view axis on hard flicks.
export const SHOULDER_SWING_GAIN = 1.9;
export const SHOULDER_MAX_SCOPE = 0.034;

// Battery is PER OPTIC: sniper chevron ships unlit (etched-only mil reticle),
// ACOG red dot ships lit.
export const batteryOn: { sniper: number; acog: number } = {
    sniper: 0,
    acog: 1,
};

export type MoveKey = 'w' | 'a' | 's' | 'd'
export const keys: Record<MoveKey, boolean> = {
    w: false,
    a: false,
    s: false,
    d: false,
};
export type LeanKey = 'q' | 'e'
export const leanKeys: Record<LeanKey, boolean> = { q: false, e: false };

// Smoothed eye offset consumed by the lens shader (mirrors the crosshair in
// cross-driven modes, a motion-fed phantom otherwise).
export const _eyeSm = new THREE.Vector2(0, 0);

// Exposed for gameplay: true point-of-impact error caused by parallax.
// Bullet logic should add this (in lens UV units) scaled to world.
export const parallaxError = new THREE.Vector2(0, 0);

export function curMag(): number {
    return S.acogActive ? MAG_ACOG : MAG_SNIPER;
}
export function curAmmo(): number {
    return S.acogActive ? S.acogAmmo : S.sniperAmmo;
}
export function setCurAmmo(v: number): void {
    if (S.acogActive) S.acogAmmo = v;
    else S.sniperAmmo = v;
}
