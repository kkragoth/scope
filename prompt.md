# Task: make the scope picture really re-point when the weapon leads (kill the "decal" limitation)

You are working in the repo at C:\Users\kkragoth\dev\scope — a three.js first-person
rifle-scope demo. TypeScript + Vite. Commands:

- run: npm run dev (pointer-lock click; right mouse button = ADS/scope)
- check: npx tsc --noEmit
- build: npm run build
  Do NOT commit anything. Keep the existing code style (heavy explanatory comments).
  Only report what you find/do; no screenshots needed.

## The problem (read this carefully)

The magnified scope image is currently a "decal": the lens shader samples the
scope render-target texture in lens-UV space, and that render target comes from a
fixed scope camera (`scopeCamera`, a child of the WEAPON group, NOT of the rifle
housing groups). The rifle geometry + lens live in `sniperGroup`/`acogGroup`
(children of `weaponGroup`), which are rotated about a shoulder pivot for free-aim.

Consequence: when the rifle "leads" (free-aim), the whole glass slides as a rigid
unit on screen, but the world content displayed under the crosshair NEVER changes,
because the picture is glued to the mesh while the scope camera stays put. True
free-aim in a real scope would rotate the barrel, so the world visibly shifts
under the reticle (the target drifts; the crosshair covers a different world point).

The current demo fakes the aim-point by a DECOUPLED crosshair overlay
(`uReticleOffset` = freeaim offset) drawn offset from the picture centre, plus a
crescent proportional to that decentration. This "works" mechanically but the
world never moves under the glass — the exact thing we want to attempt to fix.

## Key code locations (all in src/main.ts; line numbers approx. — re-find by keyword)

- scopeCamera: search `const scopeCamera` (~line 736). Child of `weaponGroup`,
  positioned on the tube axis. Renders to `scopeTarget`, sampled by the lens shader.
- Lens shader samples the world image: search `tDiffuse`, `sampleSight`.
- Rifle housing groups + shoulder pivot rotation: search `SHOULDER_PIVOT`,
  `SHOULDER_SWING_GAIN`, `_scopeSwingX`, `sniperGroup.position.copy(SHOULDER_PIVOT)`.
  This is where sniperGroup/acogGroup get rotated about the shoulder point.
- Decoupled crosshair overlay (free-aim "lead"): search `uReticleOffset`,
  `freeaimOn`, block comment "FREEAIM aim-lead offset".
- Crescent follows crosshair: search `_crossEye`, `CRESCENT FOLLOWS THE CROSSHAIR`,
  `crossDrive`.
- Modes: search `SWAY_MODE_NAMES` — default mode 5 = BODY+FREE (housing slide +
  crosshair lead). Modes 3/4/5 drive the eye-box from crosshair decentration.
- scopeCamera roll counter for level picture: search
  `scopeCamera.rotation.z = -weaponGroup.rotation.z`.

## What to attempt

Make the scope PICTURE genuinely re-point when the weapon leads, i.e. the world
under the reticle changes, so free-aim reads as a real barrel rotation. Explore in
this order:

1. Mount/move the scope camera with the barrel lead: apply the SAME shoulder-pivot
   rotation (and/or the free-aim angle) to the scope camera's aim so the render it
   produces is the view down the (rotated) barrel. The lens can then either keep
   showing that render or draw the reticle glued to picture centre.
2. Decide what happens to the decoupled crosshair overlay (`uReticleOffset`):
   does true re-pointing make it redundant (reticle glued at centre like a real
   scope) or should it stay? The USER still wants to SEE the crosshair read
   off-centre toward a corner during a lead AND a crescent proportional to how far
   off-centre it is, AND a shoulder-pivot muzzle swing with rear planted. Try to
   keep that feel; if it must change, say so explicitly and why.
3. Keep these behaviours intact or explain precisely what you changed:
   - ADS aim stays 1:1 when panning (picture must not swing off the aim line
     during normal mouse look — that was a prior failure mode; see comment
     "picture NEVER moves with mouse sway").
   - Catch-up: after a flick the crosshair/rifle eases back to centre.
   - Zoom: free-aim travel range grows with zoom; crescent scales with it.
   - No roll of the world picture from yaw/roll (scope stays level; only pitch/yaw
     lead). Counter-roll already exists for the reticle.
   - The eye-box crescent side/scale and all sway modes (X cycles 0..5) keep
     working; mode 0/2 must not be broken.

## Constraints / gotchas

- The scope render happens from `scopeCamera` each frame into `scopeTarget`
  (search `renderer.setRenderTarget(scopeTarget)`). Layer 1 (the gun) is excluded
  from that camera, so moving/rotating it with the rifle is safe for feedback
  loops, but beware of the MAIN camera vs scope camera geometry consistency
  (right-eye ADS uses a counter-yaw so the eye stays on the tube axis — keep it).
- If you rotate the scope camera, watch: no roll (keep `rotation.z` handling),
  near-plane/far-plane, and the exported `parallaxError` (gameplay hook near
  `TRUE PARALLAX ERROR`) — update it if the meaning changes.
- Prefer small, tunable constants near the other shoulder/swing constants, and
  explain what each knob does. Do not over-tune; pick sensible defaults that read
  well at the default mode 5 and note what to tweak.
- Keep comments in the same voice/style (they explain _why_).

## Acceptance / done criteria

- Running the demo (npm run dev), while ADS (RMB) in default mode 5, a hard flick
  makes the magnified WORLD visibly shift relative to the reticle/glass (the
  target no longer sits under the centre) — not just the glass sliding as a
  decal.
- The crosshair-off-centre feel + proportional crescent + shoulder-pivot muzzle
  swing still read naturally; nothing visually glitches at rest.
- `npx tsc --noEmit` and `npm run build` pass.

## Report back

Summarise: what you tried, the approach you landed on and why, every code change
with line locations, any behaviour you intentionally had to change (e.g. if the
reticle had to stop decoupling), the new tuning knobs and defaults, what you
verified, and anything that is still ugly or unresolved.

Note: the acceptance bar ("world visibly shifts under the reticle while crosshair
also stays off-centre") may be physically contradictory in one strict reading — a
real scope can't have a reticle off-centre of its own picture. Report that
trade-off honestly if you hit it, and propose the most coherent option that keeps
the good feel.
