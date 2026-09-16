import * as THREE from 'three';
import {
    ACOG_FOV,
    ADS_X_RIGHT,
    CROSS_EYE_GAIN,
    CROSS_EYE_MAX,
    RELOAD_TIME,
    S,
    SHOULDER_ARM_Z,
    SHOULDER_LEAD_GAIN,
    SHOULDER_MAX_SCOPE,
    SHOULDER_PIVOT,
    SHOULDER_SWING_GAIN,
    SNIPER_FOV,
    _eyeSm,
    config,
    curMag,
    keys,
    leanKeys,
    parallaxError,
    setCurAmmo,
} from '@/state/store';
import { SUN_DIR, camera, dirLight, renderer, scene } from '@/core/boot';
import {
    HIP_ADS_DIST,
    adsPosition,
    hipPosition,
    pitchObject,
    playerGroup,
    wPos,
    wRot,
    wRotVel,
    wVel,
    weaponGroup,
} from '@/core/player';
import {
    _camWorld,
    occluders,
    skyMat,
    sunCore,
    sunSprite,
} from '@/world/environment';
import { boltArm, boltKnob, trigger, tubeRadius } from '@/weapons/sniper';
import { acogGroup, sniperGroup } from '@/weapons/groups';
import { brassPool, flashSprite } from '@/weapons/effects';
import { scopeTarget } from '@/optics/targets';
import {
    _focusDir,
    _focusPos,
    blurA,
    blurB,
    blurMat,
    blurScene,
    dofMapEnabled,
    dofMat,
    dofScene,
    dofState,
    focusRay,
    mainTarget,
    postCam,
} from '@/optics/dof';
import { lensMat, scopeCamera } from '@/optics/scopeRig';
import { tryFire } from '@/state/actions';
import { updateAmmoUI } from '@/ui/hud';

const clock = new THREE.Clock();

// Scratch objects to avoid per-frame allocation
const _scopeFwd = new THREE.Vector3();
const _sunDir = new THREE.Vector3();
const _scopeRight = new THREE.Vector3();
const _scopeUp = new THREE.Vector3();
const _sunSide = new THREE.Vector2();
const _scopeQuat = new THREE.Quaternion();
const _eyeWorld = new THREE.Vector3();
const _eyeLocal = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _leadEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const _leadPivot = new THREE.Vector3();
// LAYER 2 — movement rotation kicks: angular acceleration tilts the gun
// (roll + a whisper of pitch). Steady motion doesn't tilt; jerks do.
let kickRoll = 0;
let kickPitch = 0;
let currentAdsWeight = 0.0;
let prevAiming = false;
let headLean = 0.0;
let manualLean = 0.0;
let holdBlend = 0.0;
// FREE-FLOAT SWAY state — the rifle is never glued to the screen. Two layers:
// common-mode (head+gun together) plus differential (gun floats vs the head).
// Summed incommensurate sines + a retargeting random walk. See animate().
let headYaw = 0;
let headPitch = 0;
let exertion = 0; // 0 rested … ~1.5 exerted; rises fast, decays slow (~4s)
let flickSm = 0; // smoothed mouse speed (drives exertion)
let wanderTX = 0;
let wanderTY = 0;
let wanderCX = 0;
let wanderCY = 0;
let wanderTimer = 0;
let heartPh = 0; // heartbeat phase (rate drifts with exertion/hold)
const seedA = Math.random() * Math.PI * 2;
const seedB = Math.random() * Math.PI * 2;
const seedC = Math.random() * Math.PI * 2;
const seedD = Math.random() * Math.PI * 2;
const TAU = Math.PI * 2;
// Sun occlusion test (1 = visible, 0 = blocked; smoothed per-frame)
const sunRay = new THREE.Raycaster();
sunRay.far = 800;
let sunVis = 1.0;
// PERF: sun occlusion raycast runs every 4th frame (result is smoothed by
// sunVis anyway, so no popping). Was a full 151-target JS raycast per frame.
let sunTick = 0;
let sunBlockedCache = false;
// PERF: module-scope movement scratch — was 2 heap allocs per frame.
const _moveDir = new THREE.Vector3();
const _moveEuler = new THREE.Euler();
// Walk-bob blend: ramps 0↔1 instead of a binary gate, so starting/stopping
// never steps the weapon (a 4mm step through 4.5x parallax reads as a snap).
let moveBlend = 0;
export function animate(): void {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 1 / 30);
    const time = clock.getElapsedTime();

    if (document.pointerLockElement === document.body) {
        const speed = 15 * delta;
        _moveDir.set(0, 0, 0);
        if (keys.w) _moveDir.z -= 1;
        if (keys.s) _moveDir.z += 1;
        if (keys.a) _moveDir.x -= 1;
        if (keys.d) _moveDir.x += 1;

        _moveDir.normalize().multiplyScalar(speed);
        _moveEuler.set(0, playerGroup.rotation.y, 0);
        _moveDir.applyEuler(_moveEuler);
        playerGroup.position.add(_moveDir);

        const targetMainFov = S.isAiming ? 55 : 70;
        camera.fov += (targetMainFov - camera.fov) * 12 * delta;
        camera.updateProjectionMatrix();

        // LAYER 1 — head eases toward look intent (mass, ~30/s, no teleport).
        // Eased into headYaw/headPitch; the free-float sway below overlays at
        // assignment time so it never corrupts look intent (mouse stays 1:1).
        headYaw += (S.yawTarget - headYaw) * Math.min(1, 30 * delta);
        headPitch += (S.pitchTarget - headPitch) * Math.min(1, 30 * delta);

        // WHOLE-WEAPON TARGETS: anchor follows intent; sway offsets ride along.
        const targetWeight = S.isAiming ? 1.0 : 0.0;
        // K-toggle: ADS anchor slides right for the right-eye stance. Hip never
        // moves — this only affects the shouldered position.
        adsPosition.x = S.rightEye ? ADS_X_RIGHT : 0.0;
        _anchor.lerpVectors(hipPosition, adsPosition, targetWeight);
        // X sway mode gate: modes 1/2/3/4/5 (all but FREE) multiply the whole
        // free-float / physical-sway layer by 0 so the rifle behaves rigidly.
        // Only base rotations (hip→ADS easing), recoil impulses and manual Q/E
        // lean survive. FREEAIM / BODY / BODY+FREE re-add their own offsets below.
        const swayOn = S.swayMode === 0 ? 1.0 : 0.0;
        const freeaimOn = S.swayMode === 3 || S.swayMode === 5 ? 1.0 : 0.0;
        const bodyOn = S.swayMode === 4 || S.swayMode === 5 ? 1.0 : 0.0;
        // Plumb reticle while ADSing: panning the cursor is a YAW, and a yaw must
        // never roll the rifle — rolling the tube on a lateral sweep is what tips
        // the crosshair's bottom line away from straight-down. The little mouse-
        // derived ROLL (and mouse-driven head lean) that sells "gun carries into a
        // turn" at the hip reads as a broken scope through the glass, so both are
        // gated off once shouldered. Organic breath/stride roll, real Q/E lean and
        // the yaw/pitch weapon lag (eye-box) are untouched.
        const panRoll = S.isAiming ? 0.0 : 1.0;
        // TWO SEPARATE SYSTEMS at the shoulder: WHERE YOU LOOK (the tube aim + its
        // picture) is driven by the mouse, and sway must NOT detach it. The old
        // mouse-lag rotation — the rifle trailing a pan like it carries inertia —
        // is a hip-language cue; at ADS magnification that lag (up to ~0.08 rad,
        // wider than the whole scope field once zoomed) swung the picture off the
        // aim line and "snapped back" when the pan ended. It eases out as the
        // cheek weld seats so the shoulder transition never pops. The scope keeps
        // its eye-relief life not by rotating the tube but via a synthetic
        // cheek-weld error (see the eye-vector block) — the crescent reacts to
        // weapon motion while the picture stays rigidly on the aim line.
        const aimLagK = THREE.MathUtils.lerp(1.0, 0.0, currentAdsWeight);

        const holdRate = S.breathHeld ? 5.0 : 3.0;
        holdBlend +=
      ((S.breathHeld ? 1 : 0) - holdBlend) * Math.min(1, holdRate * delta);
        if (!S.breathHeld && holdBlend < 0.001) holdBlend = 0;
        const breathFactor = 1.0 - holdBlend * 0.93;

        const moveTarget = keys.w || keys.a || keys.s || keys.d ? 1.0 : 0.0;
        moveBlend += (moveTarget - moveBlend) * Math.min(1, 6 * delta);
        if (moveBlend < 0.001) moveBlend = 0;
        const walkPh = time * 9.0;
        // All smooth sinusoids — the old abs(cos) vertical bounce had a velocity
        // cusp every half period that read as a micro-snap at high zoom.
        const bobScale = THREE.MathUtils.lerp(1.0, 0.25, currentAdsWeight);
        const bobX =
      (Math.sin(walkPh) * 0.004 * moveBlend + Math.sin(time * 1.7) * 0.0015) *
      bobScale;
        const bobY =
      (Math.sin(walkPh * 2.0) * 0.0025 * moveBlend +
        Math.sin(time * 2.3) * 0.0012) *
      bobScale;
        const bobZ =
      (Math.sin(time * 1.1) * 0.003 + Math.sin(walkPh) * 0.002 * moveBlend) *
      bobScale;
        // Shoulder travel: each stride pushes the rifle into/away from the cheek
        // weld, modulating EYE RELIEF directly while moving — even at full ADS the
        // scope breathes in and out against your eye. Kept partly active at ADS
        // (unlike bob, which collapses to 25%) so the exit-pupil aperture visibly
        // swells and pinches with every footfall at high magnification.
        const shoulderZ =
      Math.sin(walkPh * 2.0 + 0.5) *
      0.011 *
      moveBlend *
      THREE.MathUtils.lerp(1.0, 0.55, currentAdsWeight);
        // slow positional drift: gun wanders under the eye (more at hip)
        const driftScale =
      THREE.MathUtils.lerp(1.0, 0.3, currentAdsWeight) * breathFactor;
        const driftX = Math.sin(time * 0.9 + 1.3) * 0.006 * driftScale;
        const driftY = Math.sin(time * 1.2 + 0.4) * 0.004 * driftScale;

        // ---- PHYSICAL SWAY: the WHOLE gun swings as a body, not the image ----
        // Breathing is a slow chest rise/fall; walking swings the rifle like a
        // pendulum with each stride. Both feed the spring-damper BELOW as
        // rotational targets, so the gun answers with mass and the scope + world
        // + reticle all rotate together. Deliberately bigger than the old
        // hand-tuned wobble — a real rifle at the shoulder never sits still.
        // Shouldered amplitudes are now heavily tamed: just enough slow motion to
        // read "alive" through the glass without the reticle wandering off target.
        // Hip keeps the old body-language values.
        const breathAmp = (S.isAiming ? 0.0022 : 0.02) * breathFactor;
        const breathRX = Math.sin(time * 2.1 + 0.4) * breathAmp;
        const breathRY = Math.cos(time * 1.05 + 0.9) * (breathAmp * 0.55);
        const breathRR = Math.sin(time * 1.3 + 2.0) * (breathAmp * 0.4);
        // stride pendulum: roll + yaw lag with each footfall, strongest at hip,
        // still present (shoulder carries momentum) while ADS.
        const strideAmp = (S.isAiming ? 0.0018 : 0.03) * moveBlend;
        const stepRX = Math.sin(walkPh) * strideAmp;
        const stepRY = Math.cos(walkPh * 0.5) * (strideAmp * 0.6);
        const stepRR = Math.sin(walkPh * 1.3) * (strideAmp * 0.45);

        // ---- FREE-FLOAT SWAY: the rifle is never glued to the screen ----
        // Exertion rises fast (walking / flicking), decays slow (~4s).
        const instFlick =
      (Math.hypot(S.moveImpX, S.moveImpY) / Math.max(delta, 1e-3)) * 0.001;
        flickSm += (instFlick - flickSm) * Math.min(1, 10 * delta);
        // Eye-box exaggeration only for FAST swings: flickSm ≈ mouse px/s * 1e-3,
        // so shape it with a threshold — gentle corrective moves stay ≈ 0 and a
        // quick flick/pan slams to ~1 (then lingers while the eye re-seats).
        {
            const spdT = THREE.MathUtils.smoothstep(flickSm, 0.25, 0.85);
            S._swaySpeed +=
        (spdT - S._swaySpeed) *
        Math.min(1, (spdT > S._swaySpeed ? 14 : 4) * delta);
        }
        lensMat.uniforms.uSwaySpeed.value = S._swaySpeed;
        const exTarget = Math.min(moveBlend * 0.8 + flickSm * 5.0, 1.5);
        exertion +=
      (exTarget - exertion) *
      Math.min(1, (exTarget > exertion ? 2.0 : 0.35) * delta);
        S.gaspT = Math.max(0, S.gaspT - delta);
        // Sway activity + zoom response (Z / SWAY-ONLY): swayAct feeds the eye-box
        // suppression below; stillZoom (and the damp above) shape how zoom scales
        // the free-float wobble. swayAct ≈ 0 when the rifle sits still, ~1 when it
        // is actually being swung/flicked.
        // ZOOM LINK: squared mag, floor near-zero so fully zoomed-out stays put.
        // min 0.04 (not 0.25): at sniper min-zoom mag=0.2 -> 0.04x drive, the
        // cross stays in place and the crescent barely forms. Base mag -> 1x.
        const zoomTw = THREE.MathUtils.clamp(
            Math.pow((S.acogActive ? ACOG_FOV : SNIPER_FOV) / config.fov, 2.0),
            0.04,
            6.0,
        );
        const swayAct = THREE.MathUtils.clamp(
            Math.hypot(S.mouseVelocityX, S.mouseVelocityY) * 40.0 +
        moveBlend * 0.6 +
        flickSm * 8.0,
            0.0,
            1.0,
        );
        const stillZoom = THREE.MathUtils.smoothstep(zoomTw, 1.6, 5.0);
        // Zoomed aim wobble is DAMPED, not amplified: the magnified view already
        // enlarges any angular sway, so pushing it up makes the whole screen shake
        // apart. Damp hard once you're well zoomed and shouldered.
        const zoomSwayDamp = THREE.MathUtils.lerp(
            1.0,
            0.15,
            currentAdsWeight * stillZoom,
        );
        // Heavy sniper breathes slow and deep; the light carbine is snappier but
        // trembles more.
        const lowK = S.acogActive ? 0.8 : 1.15;
        const tremorK = S.acogActive ? 1.25 : 0.7;
        // Exertion (mouse flicks / running) is a HIP sway driver — while aiming it
        // would make every small correction pump the wobble up for seconds, so its
        // contribution is damped to ~30% at the shoulder.
        const swayAmp =
      (S.isAiming ? 0.2 : 2.0) *
      (1.0 + exertion * 0.7 * (S.isAiming ? 0.3 : 1.0));
        // Tremor (8–13 Hz) and the heartbeat pulse are the "shake band": through a
        // magnified sight they read as jitter, not drift, so they are all but
        // switched off at the shoulder. Slow breath + wander carry the idle life.
        const hfK = S.isAiming ? 0.08 : 1.0;
        // Shift gates nearly everything: a deliberate hold leaves only a sliver of
        // residual sway and a slowed, faded pulse — the sight picture goes ~still.
        const steadyK = 1.0 - holdBlend * 0.93;
        const swayGate = swayAmp * steadyK;
        // Random-walk aim wander: retargets ~1/s, cruises there slowly. This is
        // the "can't hold perfectly still" — the crosshair roams the target.
        wanderTimer -= delta;
        if (wanderTimer <= 0) {
            wanderTimer = 0.7 + Math.random() * 0.9;
            const wA = 0.0022 * swayGate * lowK * swayOn;
            wanderTX = (Math.random() * 2 - 1) * wA;
            wanderTY = (Math.random() * 2 - 1) * wA * 0.7;
        }
        const cruiseK = Math.min(1, (S.acogActive ? 3.0 : 2.2) * delta);
        wanderCX += (wanderTX - wanderCX) * cruiseK;
        wanderCY += (wanderTY - wanderCY) * cruiseK;
        // Breathing: ~13/min fundamental + 2nd harmonic (exhale longer than
        // inhale), incommensurate yaw/roll copies so it never loops cleanly.
        const brPh = time * TAU * 0.22 + seedA;
        const brA = breathFactor * swayGate * lowK;
        const brP = Math.sin(brPh) * 0.003 + Math.sin(brPh * 2 + 1.1) * 0.0008;
        const brY = Math.sin(brPh * 0.5 + 0.7 + seedB) * 0.0018;
        const brR = Math.sin(brPh * 0.5 + 2.0 + seedC) * 0.001;
        // Heartbeat: sharp systolic thump. Controlled breathing (Shift) slows it
        // down and fades it — the hold goes quiet instead of pounding.
        heartPh += delta * (1.1 + exertion * 0.5) * (1.0 - holdBlend * 0.35);
        const hbThump = Math.pow(Math.max(Math.sin(heartPh * TAU), 0), 8);
        const hbAmp =
      0.0012 * (0.4 + exertion * 1.2) * (1.0 - holdBlend * 0.6) * hfK;
        // Physiological tremor, 8–13 Hz — sub-pixel at rest, grows with exertion.
        // Squashed at the shoulder (hfK): through magnification it reads as a
        // 10 Hz jitter on the reticle, which is exactly the "jerky" look.
        const tremorA = (0.25 + exertion) * tremorK * (0.2 + 0.8 * steadyK);
        const trX =
      (Math.sin(time * TAU * 9.3 + seedB) * 0.0006 +
        Math.sin(time * TAU * 12.7 + seedD) * 0.0004) *
      tremorA *
      hfK;
        const trY =
      (Math.sin(time * TAU * 8.1 + seedC) * 0.0006 +
        Math.sin(time * TAU * 11.3 + seedA) * 0.0004) *
      tremorA *
      hfK;
        // Gasp shudder after releasing Shift.
        const gaspW = Math.sin(time * 57.0) * ((S.gaspT / 0.6) * 0.004);
        // COMMON-MODE (head + gun together): aim wanders over the world, the eye
        // geometry is untouched so the lens stays clear.
        const swayYaw = (wanderCX + brY * brA + trY * 0.5) * swayOn;
        const swayPitch =
      (wanderCY + brP * brA + hbThump * hbAmp + trX * 0.5 + gaspW) * swayOn;
        const swayRoll = (brR * brA + hbThump * hbAmp * 0.4) * swayOn;
        playerGroup.rotation.y = headYaw + swayYaw * zoomSwayDamp;
        pitchObject.rotation.x = headPitch + swayPitch * zoomSwayDamp;
        // DIFFERENTIAL (gun floats against the head): a phase-lagged chest copy
        // so the rifle trails the torso, plus slow positional float and tremor.
        // Peak ~4 mrad + ~4 mm — the scope visibly breathes on screen while the
        // eye stays deep inside the eye box (whisper of crescent at extremes).
        const lagPh = brPh - 0.7;
        const diffYaw =
      Math.sin(lagPh * 0.5 + 0.7 + seedB) * 0.0012 * brA +
      (Math.sin(time * 0.9 + seedC) * 0.0012 +
        Math.sin(time * 1.7 + seedD) * 0.0007) *
        swayGate +
      trY;
        const diffPitch =
      (Math.sin(lagPh) * 0.0015 + Math.sin(lagPh * 2 + 1.1) * 0.0006) * brA +
      (Math.sin(time * 1.1 + seedA + 2.0) * 0.0012 +
        Math.sin(time * 1.9 + seedB) * 0.0007) *
        swayGate +
      trX +
      gaspW * 0.7;
        const diffRoll =
      Math.sin(time * 0.8 + seedD) * 0.0008 * swayGate + trX * 0.5;
        // Positional float, meters: the muzzle end wanders while the cheek weld
        // holds. Doubled at hip where nobody is looking through glass.
        const hipK = S.isAiming ? 1 : 2;
        const floatX =
      (Math.sin(time * 0.7 + seedA) * 0.0025 +
        Math.sin(time * 1.3 + seedB) * 0.0012) *
      hipK *
      steadyK;
        const floatY =
      (Math.sin(time * 0.9 + seedC + 1.0) * 0.0022 +
        Math.sin(time * 1.6 + seedD) * 0.001) *
      hipK *
      steadyK;

        // CHEEK WELD: the eye rides the gun. Tracking a turn shouldered keeps
        // alignment — error is a brief transient on jerks, never a standing
        // offset while turning. So: fast stiff spring (~22/s) + tight clamp.
        // Hard flicks kiss the rim; only genuinely violent jerks flash shadow.
        const springForce = S.isAiming ? 22.0 : 8.0;
        S.mouseVelocityX = THREE.MathUtils.lerp(
            S.mouseVelocityX,
            0,
            springForce * delta,
        );
        S.mouseVelocityY = THREE.MathUtils.lerp(
            S.mouseVelocityY,
            0,
            springForce * delta,
        );
        S.mouseVelocityX = THREE.MathUtils.clamp(S.mouseVelocityX, -0.09, 0.09);
        S.mouseVelocityY = THREE.MathUtils.clamp(S.mouseVelocityY, -0.09, 0.09);

        // LAYER 2 — acceleration kicks: this frame's mouse impulse tilts the gun
        // (roll + whisper of pitch). Steady motion holds no tilt; jerks do.
        // Impulse is consumed here, so kicks can't accumulate.
        {
            const kickT = Math.min(1, 10 * delta);
            kickRoll +=
        (THREE.MathUtils.clamp(-S.moveImpX * 0.0004, -0.05, 0.05) *
          swayOn *
          panRoll -
          kickRoll) *
        kickT;
            kickPitch +=
        (THREE.MathUtils.clamp(-S.moveImpY * 0.0002, -0.03, 0.03) * swayOn -
          kickPitch) *
        kickT;
            S.moveImpX = 0;
            S.moveImpY = 0;
        }

        // HEAD LEAN: auto (strafe + lateral flick) + manual Q/E. Applied to
        // pitchObject so head AND gun move together — the world (inside and
        // outside the scope) tilts and shifts for corner-peeking while the optic
        // stays usable. The weapon adds its own EXTRA roll on top (below) — the
        // difference between the two is what tilts the reticle against the image.
        {
            const strafe = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
            const leanTarget = THREE.MathUtils.clamp(
                (-strafe * 0.028 - S.mouseVelocityX * 0.12 * panRoll) * swayOn,
                -0.06,
                0.06,
            );
            headLean += (leanTarget - headLean) * Math.min(1, 8 * delta);
            const manualTarget = (leanKeys.q ? 1 : 0) - (leanKeys.e ? 1 : 0);
            manualLean += (manualTarget - manualLean) * Math.min(1, 10 * delta);
            pitchObject.rotation.z = headLean + manualLean * 0.1 + swayRoll;
            pitchObject.position.x = -manualLean * 0.08;
            pitchObject.position.y = -Math.abs(manualLean) * 0.02;
        }

        // LAYER 2/3 — integrate. Rotation chases (base + lag + breath + kicks),
        // position chases (anchor + bob + drift). Slightly underdamped, so the
        // shoulder lands with mass and a breath of overshoot instead of on rails.
        // ADS weight is DERIVED from where the gun is — glass follows physics.
        // Right-eye counter-yaw: rotate the tube so its rear (+Z) axis passes
        // through the eye (camera at pitchObject x ≈ 0). theta = -atan(x/depth):
        // a bare 50mm sideways shift would leave the eye ~1 tube-radius off-axis
        // and the eye-box crescent would close the lens. On-axis the shader sees
        // uEyeOffset ≈ 0 / uEyeRelief ≈ 1, so the sight picture stays full-bright
        // and the scopeCamera (a tube child) shows the world region the scope
        // actually covers — no content mismatch, just a slight foreshortening
        // tilt from the ~7.5° viewing angle, like a real offset optic.
        const yawAds = S.rightEye ? -Math.atan2(adsPosition.x, -adsPosition.z) : 0.0;
        const baseRotY = THREE.MathUtils.lerp(0.15, yawAds, targetWeight);
        const baseRotZ = THREE.MathUtils.lerp(0.05, 0.0, targetWeight);
        {
            // Mouse lag drives the eye-box at the HIP, where the gun trailing the
            // pan reads as inertia. Once shouldered the aim line is rigid to the
            // look direction (aimLagK → 0), so mouse-derived lag can never detach
            // the scope picture from where you are pointing. Breathing + stride
            // still move the tube a little at the shoulder, and recoil punches in.
            const tRX =
        swayOn *
        (-S.mouseVelocityY * 0.9 * aimLagK +
          breathRY +
          stepRX +
          kickPitch +
          diffPitch);
            const tRY =
        baseRotY +
        swayOn *
          (-S.mouseVelocityX * 0.9 * aimLagK + breathRX + stepRY + diffYaw);
            // panRoll: cursor L/R panning never rolls the tube (bottom line of the
            // reticle stays plumb); only organic roll sources and firing kick remain.
            const tRZ =
        baseRotZ +
        swayOn *
          (-S.mouseVelocityX * 0.6 * panRoll * aimLagK +
            breathRR +
            stepRR +
            kickRoll * panRoll +
            diffRoll);
            const KR = 128;
            const CR = 17.0;
            const KP = 88;
            const CP = 16.8;
            wRotVel.x += ((tRX - wRot.x) * KR - wRotVel.x * CR) * delta;
            wRotVel.y += ((tRY - wRot.y) * KR - wRotVel.y * CR) * delta;
            wRotVel.z += ((tRZ - wRot.z) * KR - wRotVel.z * CR) * delta;
            wRot.x += wRotVel.x * delta;
            wRot.y += wRotVel.y * delta;
            wRot.z += wRotVel.z * delta;
            weaponGroup.rotation.set(wRot.x, wRot.y, wRot.z);
            wVel.x +=
        ((_anchor.x + (bobX + driftX + floatX) * swayOn - wPos.x) * KP -
          wVel.x * CP) *
        delta;
            wVel.y +=
        ((_anchor.y + (bobY + driftY + floatY) * swayOn - wPos.y) * KP -
          wVel.y * CP) *
        delta;
            wVel.z +=
        ((_anchor.z + (bobZ + shoulderZ) * swayOn - wPos.z) * KP -
          wVel.z * CP) *
        delta;
            wPos.x += wVel.x * delta;
            wPos.y += wVel.y * delta;
            wPos.z += wVel.z * delta;
            weaponGroup.position.copy(wPos);
            const dAds = wPos.distanceTo(adsPosition);
            const aw = THREE.MathUtils.clamp(1 - dAds / HIP_ADS_DIST, 0, 1);
            currentAdsWeight = aw * aw * (3 - 2 * aw);
        }
        lensMat.uniforms.uAdsWeight.value = currentAdsWeight;

        // SCOPE IMAGE STAYS LEVEL WHILE THE RETICLE ROLLS: the objective lenses
        // are rotationally symmetric, so rolling the tube around its own optical
        // axis must NOT rotate the world image — only the etched reticle (drawn
        // in the shader, rotated by uReticleRoll) tilts with the gun. Counter-
        // rolling the render camera here cancels the weapon-relative roll while
        // preserving head lean from pitchObject, so horizon "/" vs "\" comes
        // from the head and the cross "/" vs "\" comes from the gun. Correct on
        // all 3 planes: pitch/yaw flow through from the barrel, roll does not.
        scopeCamera.rotation.z = -weaponGroup.rotation.z;

        // ---- TRUE 3D EYE VECTOR: where is the eye in tube space? ----
        // eyeLocal = camera world pos expressed in weaponGroup (tube) frame.
        // x/y = lateral error (radii), z = distance behind tube origin. This
        // single vector captures hip offset, ADS alignment, sway rotations, bob
        // and breathing with correct 3-plane coupling — no hand-tuned 2D fake.
        {
            // matrices must be fresh: rotations/positions above changed this frame
            pitchObject.updateWorldMatrix(true, true);
            camera.getWorldPosition(_eyeWorld);
            _eyeLocal.copy(_eyeWorld);
            weaponGroup.worldToLocal(_eyeLocal);
            const isAcog = (lensMat.uniforms.uOpticMode.value as number) > 0.5;
            const tubeR = isAcog ? 0.0355 : tubeRadius;
            const ocularZ = isAcog ? 0.14 : 0.235;
            const optRelief = isAcog ? 0.24 : 0.145; // ADS eye-to-ocular distance
            const reliefDist = Math.max(_eyeLocal.z - ocularZ, 0.02);
            // ZOOM TIGHTENS THE EYE BOX — prominently: higher magnification = much
            // more critical eye position AND relief (true on real optics). The exit
            // pupil diameter = objective / magnification, so the eye box and the
            // usable eye relief both collapse as you crank magnification: base mag
            // reads ~1x gain, fully zoomed runs ~6x. Quadratic falloff so the
            // forgiving end drops off fast while the top end bites hard — this is
            // the "harder eye relief when zoomed" feel the shader eats up.
            const baseFov = isAcog ? ACOG_FOV : SNIPER_FOV;
            // ZOOM LINK (same floor as zoomTw): zoomed-out -> error collapses toward
            // zero (cross stays, crescent fades); zoomed-in -> error amplifies.
            const zoomTighten = THREE.MathUtils.clamp(
                Math.pow(baseFov / config.fov, 2.0),
                0.04,
                6.0,
            );
            // FREEAIM/BODY zoom link: 0 at lowest mag, full at highest. Tied to
            // wheel position (fov 15 -> 0, fov 1 -> 1, quadratic so the low end
            // stays near-zero longer), NOT to base-mag — fully zoomed-out never
            // moves, no matter the optic. Kept separate from the optical
            // zoomTighten above (which drives the crescent/relief).
            const zoom01 = THREE.MathUtils.clamp((15 - config.fov) / 14, 0, 1);
            const freeZoom = zoom01 * zoom01;
            // CRESCENT zoom link: 0 at lowest mag (fov 15 -> eyeMax 0, no crescent
            // even on hard mouse flicks), growing proportionally to full bite at
            // highest mag. Same wheel factor as freeaim/body so cross + crescent
            // scale together.
            const eyeMax = 0.375 * freeZoom;
            // ZOOM-OUT SHRINK RATIOS: <1 only while wheeling OUT (clamped to 1
            // otherwise, so zooming IN never touches stored states — the fast
            // attack builds the bigger lead up naturally). The eased states below
            // are glass-space expressions of the lead: when zoom collapses, their
            // old zoomed-in magnitude is stale, so scale them by the same ratio.
            // Sway-stop decay still rides the slow releases (this only bites when
            // the wheel actually moved), and mode exits still ease out with no
            // snap (this keys on zoom, not on the mode/ADS gate).
            const zoomShrink =
        S.prevFreeZoom > 1e-4
            ? THREE.MathUtils.clamp(freeZoom / S.prevFreeZoom, 0, 1)
            : 1;
            const relShrink =
        S.prevZoomTighten > 1e-4
            ? THREE.MathUtils.clamp(zoomTighten / S.prevZoomTighten, 0, 1)
            : 1;
            const relief = THREE.MathUtils.clamp(
                1 + (reliefDist / optRelief - 1) * zoomTighten,
                0.35,
                3.0,
            );

            // Distance-punished eye box: short drifts stay mostly free, long drifts
            // get punished. Base gain raised so mouse-driven weapon lag registers as
            // visible eye relief even at base zoom; zoomTighten amplifies it further.
            const rawX = _eyeLocal.x / tubeR;
            const rawY = _eyeLocal.y / tubeR;
            const rawMag = Math.hypot(rawX, rawY);
            const distGain =
        0.55 + 0.45 * THREE.MathUtils.smoothstep(rawMag, 0.3, 1.5);
            // PHANTOM EYE-BOX (every sway mode once shouldered): the tube aim is
            // rigid to the look direction (aimLagK above), so the real eye vector
            // stays dead-centre and no crescent would ever show. A synthetic
            // cheek-weld error — fed by the same motion signals the old weapon lag
            // used (mouse velocity, slow breathing, stride) — drives the exit-pupil
            // shadow instead. This is the "where I look" vs "sway" split: the
            // picture NEVER moves with mouse sway — only the shadow bites — so
            // panning to re-aim stays 1:1 at any zoom while the optic still reads as
            // an imperfect cheek weld. Ramps in with currentAdsWeight, then rides
            // the zoom-gain / operator-reseat pipeline below exactly like real sway.
            // LOCKED (mode 1) opts out entirely; LOCKED+EYE (mode 2) and FREE
            // (mode 0, gentler) run this phantom copy. FREEAIM / BODY / BODY+FREE
            // (modes 3/4/5) SKIP the phantom — their crescent is driven directly by
            // the crosshair's off-centre position further down, so the shadow tracks
            // the visible reticle decentration 1:1 instead of raw mouse motion.
            // HOLD BREATH (Shift): the cheek weld becomes deliberate — the synthetic
            // error ramps to zero with holdBlend so the eye re-seats dead-centre and
            // the crescent closes at ANY zoom while you're steadying.
            const phK =
        currentAdsWeight *
        (1.0 - holdBlend) *
        (S.swayMode === 1
            ? 0.0
            : S.swayMode === 2 ||
              S.swayMode === 3 ||
              S.swayMode === 4 ||
              S.swayMode === 5
                ? 1.0
                : 0.6);
            const phX =
        (S.mouseVelocityX * 2.0 +
          Math.sin(time * 0.9 + seedC) * 0.02 +
          Math.sin(walkPh) * 0.035 * moveBlend) *
        phK;
            const phY =
        (-S.mouseVelocityY * 1.4 +
          Math.sin(time * 1.2 + seedA) * 0.02 +
          Math.cos(walkPh * 2.0) * 0.03 * moveBlend) *
        phK;
            const softX = (Math.tanh(rawX * 0.9) * distGain + phX) * zoomTighten;
            const softY = (Math.tanh(rawY * 0.9) * distGain + phY) * zoomTighten;
            // eyeMax: zoomed-out caps the eye error tiny (less crescent even on
            // hard flicks); zoomed-in lets it run past base for a bigger bite.
            const eyeU = THREE.MathUtils.clamp(softX * 0.8, -eyeMax, eyeMax);
            const eyeV = THREE.MathUtils.clamp(softY * 0.8, -eyeMax, eyeMax);
            // Zoom blackening response (Z): eyeU/eyeV/relief are ALREADY zoom-
            // amplified, so the only knob needed is how much of that error "counts".
            // When the rifle is sitting still we suppress it (harder as you zoom),
            // and when it is actually moving/swaying we let the full amplified error
            // through — that makes a still zoomed hold stay clean while a sway at
            // high magnification still blackens hard. swayAct / stillZoom computed
            // above in the sway block.
            const restGain = S.zoomSwayOnly
                ? THREE.MathUtils.lerp(1.0, 0.18, stillZoom)
                : 1.0;
            const zoomGain = THREE.MathUtils.lerp(restGain, 1.0, swayAct);
            const eyeUEff = eyeU * zoomGain;
            const eyeVEff = eyeV * zoomGain;
            const reliefEff = THREE.MathUtils.clamp(
                1.0 + (relief - 1.0) * zoomGain,
                0.35,
                3.0,
            );
            // Operator re-seat, asymmetric: the eye LOSES the box fast (attack)
            // and re-finds it slowly (release). Fast L-R flicks punch shadow in
            // on every reversal instead of averaging out to nothing.
            // Eye-box hold mode (G) only changes the *target* and the release rate:
            //   CLEAN  — re-seat to true geometry as below (shadow closes at rest).
            //   SOFT   — a standing wander keeps the eye just off dead-centre, so a
            //            soft gradiented crescent never fully disappears.
            //   STICKY — in ADS the eye does NOT re-seat (release ≈ 0); the crescent
            //            stays where the sway left it. Un-shouldering (hip) resets it
            //            fast, re-shouldering starts a fresh weld, and holding breath
            //            (SHIFT) lets you deliberately re-seat back into the box.
            {
                // X modes 3/4/5 (FREEAIM / BODY / BODY+FREE) drive the eye-box from
                // the CROSSHAIR's off-centre position instead of a raw mouse-velocity
                // phantom: the crescent appears because the cross sits off the aim
                // line, and it closes as the body catches up and the cross eases back
                // to centre. The crosshair's own easing (18 attack / 2.8 catch-up)
                // carries the motion, so the eye just mirrors it exactly — shadow and
                // crosshair move as one. Modes 0/2 keep the synthetic phantom eye.
                const crossDrive =
          S.swayMode === 3 || S.swayMode === 4 || S.swayMode === 5;
                const aimRising = S.isAiming && !prevAiming;
                prevAiming = S.isAiming;
                let tgtX = crossDrive ? S._crossEyeX : eyeUEff;
                let tgtY = crossDrive ? S._crossEyeY : eyeVEff;
                if (!crossDrive && S.eyeBoxMode === 2) {
                    // SOFT's standing wander is what stops the eye from re-seating fully;
                    // holding breath (Shift) lets the weld settle anyway.
                    const wob =
            0.1 *
            (0.7 + 0.3 * Math.sin(time * 0.9 + seedA)) *
            (S.isAiming ? 1.0 : 0.0) *
            (1.0 - holdBlend);
                    tgtX += Math.sin(time * 0.53 + seedB) * wob;
                    tgtY += Math.cos(time * 0.41 + seedC) * wob * 0.8;
                }
                if (aimRising && S.eyeBoxMode === 3) {
                    _eyeSm.set(0, 0); // fresh shoulder weld clears the stuck shadow
                }
                const tgtMag = Math.hypot(tgtX, tgtY);
                const curEyeMag = Math.hypot(_eyeSm.x, _eyeSm.y);
                let releaseRate = 6.0;
                if (S.eyeBoxMode === 3) {
                    releaseRate = S.isAiming ? (S.breathHeld ? 3.0 : 0.35) : 8.0;
                } else if (S.breathHeld) {
                    // holding breath re-seats the eye fast: the crescent you had before
                    // steadying clears promptly instead of decaying over a beat
                    releaseRate = 12.0;
                }
                // crossDrive: snap to the crosshair-derived offset (already eased by
                // the freeaim/body filters) so the crescent reads 1:1 with the cross.
                const eyeRate = crossDrive
                    ? 1.0
                    : Math.min(1, (tgtMag > curEyeMag ? 16 : releaseRate) * delta);
                const relDev = Math.abs(reliefEff - 1);
                const relCur = Math.abs(S._reliefSm - 1);
                const relRate = Math.min(1, (relDev > relCur ? 12 : 5) * delta);
                _eyeSm.x += (tgtX - _eyeSm.x) * eyeRate;
                _eyeSm.y += (tgtY - _eyeSm.y) * eyeRate;
                S._reliefSm += (reliefEff - S._reliefSm) * relRate;
                // Wheel-out melts the stored crescent now, not after the slow
                // release: pull the eased eye + relief deviation down by the same
                // ratio zoom shrank this frame. Cross-driven modes snap to
                // _crossEye anyway (already shrunk via S.freeOX/body below), so only
                // the phantom eye needs the direct rescale here.
                if (!crossDrive && zoomShrink < 1) {
                    _eyeSm.x *= zoomShrink;
                    _eyeSm.y *= zoomShrink;
                }
                if (relShrink < 1) {
                    S._reliefSm = 1 + (S._reliefSm - 1) * relShrink;
                }
            }
            ;(lensMat.uniforms.uEyeOffset.value as THREE.Vector2).copy(_eyeSm);
            lensMat.uniforms.uEyeRelief.value = S._reliefSm;
            lensMat.uniforms.uZoomK.value = zoomTighten;

            // FREEAIM aim-lead offset (lens UV units): the crosshair IS the weapon's
            // point of aim riding the barrel. On a flick the barrel rotates ahead of
            // the eye (eye–weapon–crosshair rotation), so through the eyepiece the
            // crosshair reads off the picture centre — toward a corner on hard
            // flicks — while the picture stays rigid. Release eases it back to
            // centre = the body catching up. Gated by ADS + breath hold so a steady
            // hold re-centres.
            // ZOOM-LINKED (freeZoom): 0 at lowest mag (fov 15, no movement at all),
            // full only at highest mag (fov 1). Travel RANGE (freeRange) also grows
            // with zoom so the cross rides further off-centre the more magnified the
            // view — same angular free-aim, more of the glass.
            {
                const gate = freeaimOn * currentAdsWeight * (1.0 - holdBlend) * freeZoom;
                // Travel range grows with zoom: a fixed angular free-aim spans more of
                // the magnified glass, so at high power the cross rides much further
                // off-centre (near-zero range when fully zoomed out). The breathing
                // wander keeps a small misalignment (and whisper of crescent) alive so
                // a planted rifle still reads as a living cheek weld.
                const freeRange = THREE.MathUtils.lerp(0.035, 0.19, freeZoom);
                // Flick right -> cross kicks right, flick up -> cross kicks up:
                // the barrel leads AHEAD of the look direction, not behind it.
                const tgtX =
          THREE.MathUtils.clamp(S.mouseVelocityX * 2.2, -freeRange, freeRange) *
            gate +
          Math.sin(time * 0.9 + seedB) * 0.01 * gate;
                const tgtY =
          THREE.MathUtils.clamp(
              -S.mouseVelocityY * 1.9,
              -freeRange,
              freeRange,
          ) *
            gate +
          Math.cos(time * 0.7 + seedC) * 0.01 * gate;
                const curMX = Math.hypot(S.freeOX, S.freeOY);
                const tgtMX = Math.hypot(tgtX, tgtY);
                // Fast attack (follows the flick), slow release (catch-up after stop).
                const rate = Math.min(1, (tgtMX > curMX ? 18 : 2.8) * delta);
                S.freeOX += (tgtX - S.freeOX) * rate;
                S.freeOY += (tgtY - S.freeOY) * rate;
                // Wheel-out melts the drawn lead now: same stale-state shrink as the
                // eye above — the stored zoomed-in lead would otherwise ride the
                // slow 2.8/s catch-up and keep cross + crescent big after zooming
                // out. Scaling (not snapping) keeps the melt proportional per tick.
                if (zoomShrink < 1) {
                    S.freeOX *= zoomShrink;
                    S.freeOY *= zoomShrink;
                }
                if (freeaimOn === 0) {
                    S.freeOX = 0;
                    S.freeOY = 0;
                }
                // The crosshair line rides the barrel: push the etched reticle around
                // inside the (rigid) picture so it visibly leaves the centre while the
                // weapon leads.
                ;(lensMat.uniforms.uReticleOffset.value as THREE.Vector2).set(
                    S.freeOX,
                    S.freeOY,
                );
            }

            // BODY physical housing lag: the scope housing itself slides off the eye
            // line and re-seats — scopeCamera stays rigid on the aim line so the
            // WORLD picture never detaches, but the housing + lens ride off-axis
            // ahead of the look as one unit and ease back. This is the whole-optic
            // slide in front of the eye (weapon slide), added on top of the FREEAIM
            // crosshair lead so hard flicks travel widest in BODY+FREE.
            // ZOOM-LINKED like FREEAIM (freeZoom): 0 at lowest mag, tamed travel so
            // the combo stays inside the glass even fully zoomed.
            {
                const gate = bodyOn * currentAdsWeight * (1.0 - holdBlend) * freeZoom;
                const bodyRange = THREE.MathUtils.lerp(0.002, 0.026, freeZoom);
                // Flick right -> housing kicks right, flick up -> housing kicks up.
                const tgtX =
          THREE.MathUtils.clamp(S.mouseVelocityX * 0.3, -bodyRange, bodyRange) *
            gate +
          Math.sin(time * 0.9 + seedB) * 0.0015 * gate;
                const tgtY =
          THREE.MathUtils.clamp(
              -S.mouseVelocityY * 0.26,
              -bodyRange,
              bodyRange,
          ) *
            gate +
          Math.cos(time * 0.7 + seedC) * 0.0015 * gate;
                const curM = Math.hypot(S.bodyLX, S.bodyLY);
                const tgtM = Math.hypot(tgtX, tgtY);
                const rate = Math.min(1, (tgtM > curM ? 18 : 2.8) * delta);
                S.bodyLX += (tgtX - S.bodyLX) * rate;
                S.bodyLY += (tgtY - S.bodyLY) * rate;
                // Pitch whisper (up/down only): tilts ahead with the look —
                // flick up tips the housing up, then levels out on stop. No yaw,
                // no roll — those read as broken scope.
                const tgtRX =
          THREE.MathUtils.clamp(-S.mouseVelocityY * 0.5, -0.06, 0.06) * gate;
                const rateR = Math.min(
                    1,
                    (Math.abs(tgtRX) > Math.abs(S.bodyRX) ? 18 : 2.8) * delta,
                );
                S.bodyRX += (tgtRX - S.bodyRX) * rateR;
                // Wheel-out melts the housing lag too (same stale-state shrink —
                // the shoulder swing feeds the crescent via glassUv below, so it
                // must melt together with the drawn lead above).
                if (zoomShrink < 1) {
                    S.bodyLX *= zoomShrink;
                    S.bodyLY *= zoomShrink;
                    S.bodyRX *= zoomShrink;
                }
                // No snap on mode exit: gate is 0 outside BODY so tgt is 0 and the
                // offsets ease back through this same filter instead of popping.
                // Apply the combined lead as a SHOULDER-PIVOT rotation rather than a
                // parallel slide: rotate the whole rifle about the shoulder point so
                // the rear/butt stays planted and the muzzle sweeps the arc, while the
                // scope (mounted ~SCOPE_ARM_Z ahead of the pivot) lands at the
                // requested lateral offset. A small share of the reticle lead is swung
                // as barrel too, so the front visibly points the way the crosshair
                // rides — the rest stays as the drawn crosshair for the free-aim read.
                const bodyTubeR = S.acogActive ? 0.0355 : tubeRadius;
                const scopeSx =
          (S.bodyLX + S.freeOX * 2 * bodyTubeR * SHOULDER_LEAD_GAIN) *
          SHOULDER_SWING_GAIN;
                const scopeSy =
          (S.bodyLY + S.freeOY * 2 * bodyTubeR * SHOULDER_LEAD_GAIN) *
          SHOULDER_SWING_GAIN;
                // Clamp so the glass never leaves the view axis; store the applied
                // swing for the crescent feed below (single source of truth).
                S._scopeSwingX = THREE.MathUtils.clamp(
                    scopeSx,
                    -SHOULDER_MAX_SCOPE,
                    SHOULDER_MAX_SCOPE,
                );
                S._scopeSwingY = THREE.MathUtils.clamp(
                    scopeSy,
                    -SHOULDER_MAX_SCOPE,
                    SHOULDER_MAX_SCOPE,
                );
                const leadPitch = S._scopeSwingY / SHOULDER_ARM_Z;
                const leadYaw = -S._scopeSwingX / SHOULDER_ARM_Z;
                _leadEuler.set(leadPitch + S.bodyRX, leadYaw, 0);
                // position = pivot - R*pivot  =>  the shoulder point never moves, all
                // parts rotate around it (muzzle swings most, rear barely at all).
                _leadPivot.copy(SHOULDER_PIVOT).applyEuler(_leadEuler);
                sniperGroup.position.copy(SHOULDER_PIVOT).sub(_leadPivot);
                sniperGroup.rotation.copy(_leadEuler);
                acogGroup.position.copy(sniperGroup.position);
                acogGroup.rotation.copy(_leadEuler);
            }

            // ---- CRESCENT FOLLOWS THE CROSSHAIR (FREEAIM/BODY/BODY+FREE) ----
            // The eye offset that drives the exit-pupil shadow is derived from how
            // far the cross actually sits off the eye line right now: the drawn
            // crosshair lead (freeaim, in lens-UV) PLUS the physical glass-centre
            // shift produced by the shoulder-pivot rotation of the whole rifle
            // (body lag + swung lead share). uv = 0.5 * shift / tubeR.
            // The eye offset points the SAME way the cross decentred: under the
            // default OPPOSITE crescent side the shader then bites the shadow on the
            // FAR side of the cross — a trailing crescent that keeps the aim/target
            // area clean. N still lets you ride the shadow up under the crosshair
            // itself instead.
            // Stored here for the NEXT frame, where the eye smoothing consumes it.
            {
                const cresTubeR = S.acogActive ? 0.0355 : tubeRadius;
                // Glass-centre shift in lens-UV from the SAME clamped swing applied to
                // the rotation above (uv = 0.5 * shift / tubeR). Total crosshair
                // decentre = drawn lead (S.freeOX) + that glass shift; the eye offset
                // mirrors it exactly so shadow and crosshair move together.
                const glassUvX = (S._scopeSwingX / cresTubeR) * 0.5;
                const glassUvY = (S._scopeSwingY / cresTubeR) * 0.5;
                S._crossEyeX = THREE.MathUtils.clamp(
                    (S.freeOX + glassUvX) * CROSS_EYE_GAIN,
                    -CROSS_EYE_MAX,
                    CROSS_EYE_MAX,
                );
                S._crossEyeY = THREE.MathUtils.clamp(
                    (S.freeOY + glassUvY) * CROSS_EYE_GAIN,
                    -CROSS_EYE_MAX,
                    CROSS_EYE_MAX,
                );
                // Remember today's zoom for next frame's shrink ratios above. Done
                // here (after every consumer) so all of them share the same
                // last-frame reference.
                S.prevFreeZoom = freeZoom;
                S.prevZoomTighten = zoomTighten;
            }

            // Reticle roll = weapon-relative roll in FREE only. All locked modes
            // (incl. FREEAIM / BODY / BODY+FREE) keep the etch plumb — no torque.
            lensMat.uniforms.uReticleRoll.value =
        S.swayMode === 0 ? weaponGroup.rotation.z : 0.0;
        }
        lensMat.uniforms.uTime.value = time;
        skyMat.uniforms.uTime.value = time;
        // FFP ACOG reticle follows magnification, sniper stays fixed (SFP).
        // FFP is on by default, F toggles; sniper ignores it entirely.
        const isAcogNow = (lensMat.uniforms.uOpticMode.value as number) > 0.5;
        lensMat.uniforms.uReticleScale.value =
      isAcogNow && S.ffpEnabled
          ? THREE.MathUtils.clamp(ACOG_FOV / config.fov, 0.35, 2.2)
          : 1.0;

        // ---- SUN / GLINT: project global directional light into scope view ----
        scopeCamera.getWorldDirection(_scopeFwd);
        _sunDir.copy(dirLight.position).normalize();
        scopeCamera.getWorldQuaternion(_scopeQuat);
        _scopeRight.set(1, 0, 0).applyQuaternion(_scopeQuat);
        _scopeUp.set(0, 1, 0).applyQuaternion(_scopeQuat);
        _sunSide.set(_sunDir.dot(_scopeRight), _sunDir.dot(_scopeUp));
        if (_sunSide.lengthSq() < 1e-4) _sunSide.set(0.4, 0.65);
        _sunSide.normalize()
        ;(lensMat.uniforms.uSunSide.value as THREE.Vector2).copy(_sunSide);
        const sunFacing = THREE.MathUtils.smoothstep(
            _scopeFwd.dot(_sunDir),
            -0.2,
            0.9,
        );
        const swayMag = Math.min(
            Math.hypot(S.mouseVelocityX, S.mouseVelocityY) * 4.0,
            1.0,
        );
        // ---- SUN OCCLUSION: no glare when world geometry blocks the sun ----
        // A real sun can't light the glass through a building. Raycast toward the
        // sun; fade all sun-driven effects (glare, crescent, ring, sprite) out
        // smoothly so nothing pops when the disc slips behind cover.
        camera.getWorldPosition(_camWorld);
        sunTick++;
        if (sunTick % 4 === 0) {
            sunRay.set(_camWorld, SUN_DIR);
            sunBlockedCache = sunRay.intersectObjects(occluders, false).length > 0;
        }
        sunVis += ((sunBlockedCache ? 0 : 1) - sunVis) * Math.min(1, 6 * delta);
        const facedVis = sunFacing * sunVis;
        lensMat.uniforms.uSunIntensity.value =
      0.1 + facedVis * 0.5 + swayMag * 0.2 * currentAdsWeight;
        lensMat.uniforms.uSunFacing.value = facedVis;
        sunSprite.material.opacity = 0.8 * sunVis;
        sunCore.position.copy(sunSprite.position);
        sunCore.material.opacity = facedVis * sunVis;

        // ---- TRUE PARALLAX ERROR for gameplay ----
        // Matches shader: sight clamped to 0.8*vignette, reticle = sight*sens.
        // Exported error = reticle minus image = sight*(sens-1): a whisper.
        {
            const eye = lensMat.uniforms.uEyeOffset.value as THREE.Vector2;
            const sens = lensMat.uniforms.uParallaxSens.value as number;
            const maxS = 0.485 * 0.8;
            let sx = -eye.x * 2.0;
            let sy = -eye.y * 2.0;
            const m = Math.hypot(sx, sy);
            if (m > maxS) {
                sx *= maxS / m;
                sy *= maxS / m;
            }
            parallaxError.set(sx * (sens - 1.0), sy * (sens - 1.0));
        }

        S.fireCd = Math.max(0, S.fireCd - delta);
        // held trigger in AUTO sprays at FIRE_GAP_AUTO through the same path
        if (S.triggerHeld && S.acogActive && S.fireAuto) tryFire();
        if (S.reloadT > 0) {
            S.reloadT -= delta;
            const p = 1 - Math.max(S.reloadT, 0) / RELOAD_TIME;
            // bolt throw: slides back mid-cycle, home at the end
            const throwZ = Math.sin(p * Math.PI) * 0.05;
            boltArm.position.z = 0.18 + throwZ;
            boltKnob.position.z = 0.18 + throwZ;
            boltArm.position.y = -0.195 + Math.sin(p * Math.PI) * 0.018;
            boltKnob.position.y = -0.195 + Math.sin(p * Math.PI) * 0.018;
            if (S.reloadT <= 0) {
                setCurAmmo(curMag());
                boltArm.position.set(0.06, -0.195, 0.18);
                boltKnob.position.set(0.088, -0.195, 0.18);
                updateAmmoUI();
            }
        }
        // trigger pull + return
        S.triggerPull = Math.max(0, S.triggerPull - delta * 8);
        trigger.position.z = 0.12 + S.triggerPull * 0.008;
        // flash decay
        if (S.flashT > 0) {
            S.flashT -= delta;
            flashSprite.material.opacity = Math.max(S.flashT, 0) / 0.06;
            if (S.flashT <= 0) flashSprite.visible = false;
        }
        // brass sim (pooled, zero allocs): gravity, floor bounce, spin, expiry
        for (const b of brassPool) {
            if (!b.active) continue;
            b.life -= delta;
            if (b.life <= 0) {
                b.active = false;
                b.m.visible = false;
                continue;
            }
            b.vel.y -= 9.8 * delta;
            b.m.position.addScaledVector(b.vel, delta);
            if (b.m.position.y < 0.007) {
                b.m.position.y = 0.007;
                b.vel.y *= -0.35;
                b.vel.x *= 0.6;
                b.vel.z *= 0.6;
                b.spin.multiplyScalar(0.6);
            }
            b.m.rotation.x += b.spin.x * delta;
            b.m.rotation.y += b.spin.y * delta;
            b.m.rotation.z += b.spin.z * delta;
        }

        // Sun glow sits at fixed distance along SUN_DIR from the main camera
        // (negligible parallax for the scope camera at this range).
        // (_camWorld already refreshed by the occlusion test above.)
        sunSprite.position.copy(_camWorld).addScaledVector(SUN_DIR, 700);

        // Shadow frustum follows the player so 2048px stays dense nearby.
        dirLight.position.copy(playerGroup.position).addScaledVector(SUN_DIR, 80);
        dirLight.target.position.copy(playerGroup.position);
        dirLight.target.updateMatrixWorld();

        // DOF focus: throttled center ray, smoothed. Raycaster sees layer 0
        // (occluders) — the layer-1 gun can never grab focus.
        dofState.focusTick++;
        if (dofState.focusTick % 6 === 0) {
            camera.getWorldPosition(_focusPos);
            camera.getWorldDirection(_focusDir);
            focusRay.set(_focusPos, _focusDir);
            const hits = focusRay.intersectObjects(occluders, false);
            const fd = hits.length > 0 ? hits[0].distance : 150;
            dofState.focusSm += (fd - dofState.focusSm) * 0.4;
        }
        dofMat.uniforms.uFocus.value = dofState.focusSm;

        renderer.setRenderTarget(scopeTarget);
        renderer.shadowMap.needsUpdate = true;
        renderer.render(scene, scopeCamera);

        // Map-view DOF pipeline: PARKED (dofMapEnabled false) — outer-ring glass
        // DOF carries the effect for now. Hysteresis on the switch so the
        // MSAA/no-MSAA crossover can't flicker; strength fades with the shoulder.
        if (dofMapEnabled && !dofState.active && currentAdsWeight > 0.6)
            dofState.active = true;
        else if (dofState.active && currentAdsWeight < 0.35) dofState.active = false;
        if (dofState.active) {
            dofMat.uniforms.uStrength.value = currentAdsWeight;
            renderer.setRenderTarget(mainTarget);
            renderer.render(scene, camera);
            blurMat.uniforms.tSrc.value = mainTarget.texture
            ;(blurMat.uniforms.uDir.value as THREE.Vector2).set(1, 0)
            ;(blurMat.uniforms.uTexel.value as THREE.Vector2).set(
                1.5 / blurA.width,
                1.5 / blurA.height,
            );
            renderer.setRenderTarget(blurA);
            renderer.render(blurScene, postCam);
            blurMat.uniforms.tSrc.value = blurA.texture
            ;(blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 1)
            ;(blurMat.uniforms.uTexel.value as THREE.Vector2).set(
                1.5 / blurB.width,
                1.5 / blurB.height,
            );
            renderer.setRenderTarget(blurB);
            renderer.render(blurScene, postCam);
            renderer.setRenderTarget(null);
            renderer.render(dofScene, postCam);
        } else {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
        }
    }
}
