import { createViewer } from "../viewer.js";
import { findTarget } from "./targets.js";

export function wireDemo(scene) {
    const form = document.getElementById("target-form");
    const mode = document.getElementById("search-mode");
    const nameInput = document.getElementById("target-name");
    const raInput = document.getElementById("ra");
    const decInput = document.getElementById("dec");
    const status = document.getElementById("status");
    const viewer = document.getElementById("viewer");
    const observation = createViewer();
    // The free API sleeps when idle and takes up to a minute to wake. A gateway error or timeout
    // (502/503/504, or no response) is retried once, with a note in the status line.
    const request = async (endpoint, params, retry = true) => {
        let response;
        try {
            response = await fetch(`/api/spherex/${endpoint}?${new URLSearchParams(params)}`);
        } catch (error) {
            if (!retry) throw new Error("Cannot reach the server. Check the connection and try again.");
        }
        if (!response || [502, 503, 504].includes(response.status)) {
            if (retry) {
                status.textContent = "Waking the SPHEREx data service, this can take up to a minute…";
                status.hidden = false;
                await new Promise(r => setTimeout(r, 1500));
                return request(endpoint, params, false);
            }
        }
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${response.status}`);
        }
        return response.json();
    };
    // Start waking the API now, so it is up by the time the intro ends or a target is chosen.
    fetch("/api/spherex/health").catch(() => {});
    // Only ask for band images where the API has them (avoids a 404 per target without bands).
    let catalogue = null;
    const hasBands = async key => {
        catalogue ??= request("targets", {}).catch(() => null);
        const entry = (await catalogue)?.find?.(t => t.key === key);
        return entry ? entry.has_bands !== false : true;
    };
    const back = document.getElementById("back-to-sky");
    if (!form || !mode || !status || !viewer) return;

    const say = text => { status.textContent = text; status.hidden = !text; };
    let busy = false;

    form.addEventListener("submit", async () => {
        // ui.js has already called preventDefault and validated the name field.
        if (busy) return;
        let target, label, key = null;
        if (mode.value === "coordinates") {
            const ra = Number(raInput.value), dec = Number(decInput.value);
            if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
            label = `RA ${ra.toFixed(3)}°, Dec ${dec.toFixed(3)}°`;
            target = { ra, dec, name: label };
        } else {
            const text = nameInput.value.trim();
            if (!text) return;
            const known = findTarget(text);
            label = known ? known.name : text;
            if (known) {
                key = known.key;
                target = known;
            } else {
                target = request("resolve", { name: text }).then(r => {
                    if (r.key) key = r.key;
                    return { ra: r.ra, dec: r.dec, name: r.name || text };
                });
            }
        }

        busy = true;
        observation.close();
        document.getElementById("target-panel").hidden = true;
        document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
        say(`Travelling to ${label}…`);
        // The data request runs during the flight; the flight hides however long it takes.
        const data = (async () => {
            const where = await target;
            // Coordinates or a resolved name with no key: the API matches the nearest cached
            // target within 10 arcmin, so a search near Barnard's Star still opens its frames.
            let nearby = null;
            if (!key && Number.isFinite(where?.ra) && Number.isFinite(where?.dec)) {
                nearby = await request("frames", { ra: where.ra, dec: where.dec }).catch(() => null);
                if (nearby?.target) { key = nearby.target; label = `${nearby.name} (${label})`; }
            }
            if (!key) return { frames: null, extras: {} };
            const [frames, ...extras] = await Promise.all([
                nearby ?? request("frames", { target: key }),
                ...["spectrum", "frames_by_detector", "frames_by_band"].map(async endpoint =>
                    endpoint === "frames_by_band" && !(await hasBands(key)) ? null
                        : request(endpoint, { target: key }).catch(() => null))
            ]);
            return { frames, extras: { spectrum: extras[0], detectors: extras[1], bands: extras[2] } };
        })();
        try {
            await Promise.all([scene.flyTo(target, { minDuration: 3.4 }), data]);
            await scene.finish();
            const { frames, extras } = await data;
            observation.open(label, key, frames, extras);
            say(frames ? "" : `No cached SPHEREx frames for ${label}.`);
        } catch (error) {
            if (error?.name === "AbortError") return;
            say(/HTTP 404/.test(error.message) ? `Could not find "${label}". Try another name or RA / Dec.` : `Could not reach ${label}: ${error.message}`);
            scene.reset();      // not awaited, so a new search is accepted straight away
        } finally {
            busy = false;
        }
    });

    back?.addEventListener("click", () => {
        say("");
        observation.close();
        scene.reset();
    });

    // Consume outside gestures before they reach sky picking or other controls.
    const outsideViewer = event => !viewer.hidden && !viewer.contains(event.target);
    for (const type of ["pointerdown", "pointerup"]) {
        document.addEventListener(type, event => {
            if (outsideViewer(event)) event.stopPropagation();
        }, true);
    }
    document.addEventListener("click", event => {
        if (!outsideViewer(event)) return;
        event.preventDefault();
        event.stopPropagation();
        back.click();
    }, true);

    const sharedTarget = new URL(location.href).searchParams.get("target");
    if (sharedTarget) {
        nameInput.value = sharedTarget;
        mode.value = "name";
        mode.dispatchEvent(new Event("change"));
        form.requestSubmit();
    }

    // Clicking a target beacon in the sky searches for it.
    scene.onPick(target => {
        if (busy) return;
        mode.value = "name";
        mode.dispatchEvent(new Event("change"));
        nameInput.value = target.name;
        form.requestSubmit();
    });
}
