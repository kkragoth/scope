import { S, SWAY_MODE_NAMES, curAmmo, curMag } from '@/state/store';

// DOM refs for the help banner + state pills. Grabbed once (module runs after
// DOM parse — the entry script is a deferred module at the end of <body>).
export const els = {
    sway: document.getElementById('swaystate') as HTMLParagraphElement,
    eye: document.getElementById('eyestate') as HTMLParagraphElement,
    box: document.getElementById('boxstate') as HTMLParagraphElement,
    zoom: document.getElementById('zoomstate') as HTMLParagraphElement,
    cres: document.getElementById('cresstate') as HTMLParagraphElement,
    crespower: document.getElementById('crespower') as HTMLParagraphElement,
    outline: document.getElementById('outlinestate') as HTMLParagraphElement,
    ammo: document.getElementById('ammo') as HTMLParagraphElement,
    ui: document.getElementById('ui') as HTMLDivElement,
    uihint: document.getElementById('uihint') as HTMLDivElement,
};

export function applySwayUI(): void {
    els.sway.textContent = `Weapon sway: ${SWAY_MODE_NAMES[S.swayMode]} — X cycles`;
}

export function updateAmmoUI(): void {
    const mode =
    S.acogActive && curAmmo() > 0 ? (S.fireAuto ? 'AUTO' : 'SEMI') : null;
    els.ammo.textContent =
    S.reloadT > 0
        ? 'RELOADING…'
        : `AMMO ${curAmmo()} / ${curMag()}${mode ? ` ${mode} — V mode` : ''} — R reload`;
}

// H toggles the whole #ui text banner (clean screenshots / videos).
export function setUiVisible(v: boolean): void {
    els.ui.style.display = v ? '' : 'none';
    els.uihint.style.display = v ? 'none' : '';
}
