import * as THREE from "./three.js";
import { radec } from "./util.js";

// The five cached SPHEREx targets (positions from static_export/targets.json), shown as
// beacons with planetarium-style labels. Clicking near one reports it through onPick.
export const TARGETS = [
    { key: "barnards-star", name: "Barnard's Star", ra: 269.4463, dec: 4.7682, aliases: ["Barnards Star", "GJ 699"] },
    { key: "wise-0855-0714", name: "WISE 0855-0714", ra: 133.7678, dec: -7.2429, aliases: ["WISE 0855", "WISE J0855-0714", "WISE J085510.83-071442.5"] },
    { key: "eps-ind-b", name: "Epsilon Indi B", ra: 331.0966, dec: -56.8007, aliases: ["Eps Indi B", "Eps Ind B", "Epsilon Ind B", "Eps Indi Ba"] },
    { key: "rw-aurigae", name: "RW Aurigae", ra: 76.9566, dec: 30.4013, aliases: ["RW Aur"] },
    { key: "r-draconis", name: "R Draconis", ra: 248.1672, dec: 66.755, aliases: ["R Dra"] },
];
const BEACON_DISTANCE = 1300;
const PICK_RADIUS = 32;

// Names match ignoring case, spaces, apostrophes and dashes, so "Eps Indi B", "wise 0855" and
// "barnards-star" all find their cached target without a round trip to the name resolver.
const squash = s => String(s || "").toLowerCase().replace(/[^a-z0-9+]/g, "");
export function findTarget(text) {
    const q = squash(text);
    if (!q) return null;
    return TARGETS.find(t => [t.key, t.name, ...(t.aliases || [])].some(n => squash(n) === q)) || null;
}

export function createTargetLayer({ beacons, camera }) {
    const layer = document.createElement("div");
    layer.className = "sky-labels";
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "1", overflow: "hidden" });
    document.body.appendChild(layer);

    const items = TARGETS.map(t => {
        const label = document.createElement("div");
        label.className = "sky-label";
        label.textContent = t.name;
        layer.appendChild(label);
        return { target: t, position: radec(t.ra, t.dec).multiplyScalar(BEACON_DISTANCE), label, screen: new THREE.Vector2(), visible: false };
    });
    let flight = null;     // { position, target } for a non-cached destination
    let active = null;     // key or flight target currently highlighted
    let hover = null;
    const v = new THREE.Vector3();

    function refreshBeacons() {
        const list = items.map(item => ({
            position: item.position,
            size: 34,
            intensity: item === hover ? 1.6 : 1,
            highlight: active === item.target ? 1 : 0,
        }));
        if (flight) list.push({ position: flight.position, size: 40, intensity: 1.4, highlight: 1 });
        beacons.set(list);
    }
    refreshBeacons();

    function project(item) {
        v.copy(item.position).project(camera);
        item.visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        item.screen.set((v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight);
        return item.visible;
    }

    function nearest(x, y) {
        let best = null, bestDist = PICK_RADIUS;
        for (const item of items) {
            if (!project(item)) continue;
            const d = Math.hypot(item.screen.x - x, item.screen.y - y);
            if (d < bestDist) { best = item; bestDist = d; }
        }
        return best;
    }

    return {
        pick(x, y) {
            const item = nearest(x, y);
            return item ? { ...item.target } : null;
        },
        hover(x, y) {
            const item = x == null ? null : nearest(x, y);
            if (item !== hover) {
                hover = item;
                refreshBeacons();
            }
            return Boolean(item);
        },
        // Highlight the destination. Non-cached destinations get their own beacon.
        setActive(target) {
            const known = target && items.find(i => i.target.key === target.key || (Math.abs(i.target.ra - target.ra) < 0.01 && Math.abs(i.target.dec - target.dec) < 0.01));
            active = known ? known.target : null;
            flight = target && !known ? { position: radec(target.ra, target.dec).multiplyScalar(BEACON_DISTANCE), target } : null;
            refreshBeacons();
        },
        update(labelsVisible) {
            layer.style.opacity = labelsVisible ? "1" : "0";
            if (!labelsVisible) return;
            for (const item of items) {
                const on = project(item);
                item.label.style.display = on ? "block" : "none";
                if (on) {
                    item.label.style.transform = `translate(${item.screen.x + 16}px, ${item.screen.y - 8}px)`;
                    item.label.classList.toggle("is-hover", item === hover);
                }
            }
        },
    };
}
