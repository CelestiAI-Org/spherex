import { api, CACHED_TARGETS } from "../api.js";
import { findTarget } from "./targets.js";

// DEMO GLUE, so the warm zoom can be seen working before the real integration lands.
// It listens to the existing target form (ui.js is untouched) and drives the public scene
// contract exactly as the UI code would:
//   await Promise.all([scene.flyTo(target), dataRequest]);  await scene.finish();  ...  scene.reset();
// Disable it with ?wiring=off, and delete this file once the real UI integration exists.

function mjdToDate(mjd) {
    if (!Number.isFinite(mjd)) return "—";
    return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
}

export function wireDemo(scene) {
    const form = document.getElementById("target-form");
    const mode = document.getElementById("search-mode");
    const nameInput = document.getElementById("target-name");
    const raInput = document.getElementById("ra");
    const decInput = document.getElementById("dec");
    const status = document.getElementById("status");
    const viewer = document.getElementById("viewer");
    const frameBox = document.getElementById("frame-container");
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
                target = api.resolveName(text).then(r => {
                    if (r.key && CACHED_TARGETS.includes(r.key)) key = r.key;
                    return { ra: r.ra, dec: r.dec, name: r.name || text };
                });
            }
        }

        busy = true;
        viewer.hidden = true;
        say(`Travelling to ${label}…`);
        // The data request runs during the flight; the flight hides however long it takes.
        const data = (async () => {
            await target;
            return key ? api.getFrames(key) : null;
        })();
        try {
            await Promise.all([scene.flyTo(target, { minDuration: 3.4 }), data]);
            await scene.finish();
            const frames = await data;
            showViewer(label, frames);
            say(frames ? `${label}: ${frames.frames.length} SPHEREx frames loaded.` : `Arrived at ${label}. No cached SPHEREx frames for this position.`);
        } catch (error) {
            if (error?.name === "AbortError") return;
            say(`Could not reach ${label}: ${error.message}`);
            await scene.reset();
        } finally {
            busy = false;
        }
    });

    function showViewer(label, frames) {
        const dds = viewer.querySelectorAll("dd");
        if (dds[1]) dds[1].textContent = label;
        if (dds[0]) dds[0].textContent = frames ? mjdToDate(frames.frames[0].mjd_start) : "—";
        if (frameBox) {
            frameBox.replaceChildren();
            if (frames) {
                const img = document.createElement("img");
                img.src = frames.frames[0].url;
                img.alt = `SPHEREx frame of ${label}`;
                img.className = "frame-image";
                frameBox.appendChild(img);
            }
        }
        viewer.hidden = false;
    }

    back?.addEventListener("click", () => {
        say("");
        scene.reset();
    });

    // Clicking a target beacon in the sky searches for it.
    scene.onPick(target => {
        if (busy) return;
        mode.value = "name";
        mode.dispatchEvent(new Event("change"));
        nameInput.value = target.name;
        form.requestSubmit();
    });
}
