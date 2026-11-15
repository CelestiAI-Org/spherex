// The five cached SPHEREx targets (positions from static_export/targets.json), shown as
// beacons with planetarium-style labels. Clicking near one reports it through onPick.
// `bands`: whether static_export has band images (bands.json) for it, so a search can ask for them
// straight away instead of waiting for /targets while the API wakes.
export const TARGETS = [
    { key: "barnards-star", name: "Barnard's Star", ra: 269.4463, dec: 4.7682, aliases: ["Barnards Star", "GJ 699"], bands: true },
    { key: "wise-0855-0714", name: "WISE 0855-0714", ra: 133.7678, dec: -7.2429, aliases: ["WISE 0855", "WISE J0855-0714", "WISE J085510.83-071442.5"], bands: false },
    { key: "eps-ind-b", name: "Epsilon Indi B", ra: 331.0966, dec: -56.8007, aliases: ["Eps Indi B", "Eps Ind B", "Epsilon Ind B", "Eps Indi Ba"], bands: true },
    { key: "rw-aurigae", name: "RW Aurigae", ra: 76.9566, dec: 30.4013, aliases: ["RW Aur"], bands: true },
    { key: "r-draconis", name: "R Draconis", ra: 248.1672, dec: 66.755, aliases: ["R Dra"], bands: false },
];

// Names match ignoring case, spaces, apostrophes and dashes, so "Eps Indi B", "wise 0855" and
// "barnards-star" all find their cached target without a round trip to the name resolver.
const squash = s => String(s || "").toLowerCase().replace(/[^a-z0-9+]/g, "");
export function findTarget(text) {
    const q = squash(text);
    if (!q) return null;
    return TARGETS.find(t => [t.key, t.name, ...(t.aliases || [])].some(n => squash(n) === q)) || null;
}

