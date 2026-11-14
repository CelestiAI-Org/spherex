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
    const request = async (endpoint, params) => {
        const response = await fetch(`/api/spherex/${endpoint}?${new URLSearchParams(params)}`);
        if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
        return response.json();
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
            await target;
            if (!key) return { frames: null, extras: {} };
            const [frames, ...extras] = await Promise.all([
                request("frames", { target: key }),
                ...["spectrum", "frames_by_detector", "frames_by_band"].map(endpoint =>
                    request(endpoint, { target: key }).catch(() => null))
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
            say(`Could not reach ${label}: ${error.message}`);
            await scene.reset();
        } finally {
            busy = false;
        }
    });

    back?.addEventListener("click", () => {
        say("");
        observation.close();
        scene.reset();
    });

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
