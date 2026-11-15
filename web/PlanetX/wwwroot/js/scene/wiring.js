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
    // The free API sleeps when idle. The server-side proxy already retries it and answers the cached
    // targets from its offline copy, so a slow request here usually means the API is waking: after
    // WAKING_NOTE_MS the status line shows "Waking the telescope data…" with a spinner. Network errors
    // and 502/503/504 are retried with backoff (2 s, 4 s, 8 s) before anything is reported.
    const WAKING_NOTE_MS = 2500, RETRY_DELAYS_MS = [2000, 4000, 8000];
    const WAKING_TEXT = "Waking the telescope data…";
    let pending = 0, wakingTimer = null;
    const showWaking = on => {
        if (on) {
            status.textContent = WAKING_TEXT;
            status.classList.add("is-waking");
            status.hidden = false;
        } else if (status.classList.contains("is-waking")) {
            status.classList.remove("is-waking");
            if (status.textContent === WAKING_TEXT) status.hidden = true;
        }
    };
    const track = delta => {
        pending += delta;
        clearTimeout(wakingTimer);
        if (pending > 0) wakingTimer = setTimeout(() => showWaking(true), WAKING_NOTE_MS);
        else showWaking(false);
    };
    class ApiError extends Error {
        constructor(message, status) { super(message); this.status = status; }
    }
    // `quiet` requests (background prefetches) never show the waking note.
    const request = async (endpoint, params, { quiet = false } = {}) => {
        if (!quiet) track(+1);
        try {
            for (let attempt = 0; ; attempt++) {
                let response = null;
                try {
                    response = await fetch(`/api/spherex/${endpoint}?${new URLSearchParams(params)}`);
                } catch { /* network error: retried below */ }
                // A 503 with `waking` is the proxy's final answer (it has already retried the API); other
                // gateway errors come from the hosting layer (e.g. the frontend itself restarting) and are retried.
                const final = response?.status === 503 && (await response.clone().json().catch(() => ({}))).waking;
                const transient = !final && (!response || [502, 503, 504].includes(response.status));
                if (transient && attempt < RETRY_DELAYS_MS.length) {
                    if (!quiet) showWaking(true);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                if (!response) throw new ApiError("Cannot reach the server. Check the connection and try again.", 0);
                if (!response.ok) {
                    const body = await response.json().catch(() => ({}));
                    throw new ApiError(body.error || `HTTP ${response.status}`, response.status);
                }
                const data = await response.json();
                if (response.headers.get("X-Spherex-Source") === "offline") offlineSeen = true;
                return data;
            }
        } finally {
            if (!quiet) track(-1);
        }
    };
    let offlineSeen = false;
    // Wake the API now (the page head already started a ping; this one retries), so it is up by the
    // time the intro ends or a target is chosen. Errors are ignored: requests retry on their own.
    (window.spherexWake || Promise.resolve(null))
        .then(r => (r && r.ok ? null : request("health", {}, { quiet: true })))
        .catch(() => {});
    // Visitor-facing text for a failed search: never a raw error or status code.
    const friendly = (error, label) => {
        if (error?.status === 404 || /HTTP 404/.test(error?.message)) return `Could not find "${label}". Try another name or RA / Dec.`;
        if (error?.status === 503 && error.message) return error.message;   // the proxy's own explanation
        if (error?.status === 0) return error.message;
        return `The telescope data for ${label} is not available right now. Try again in a minute, or pick one of the cached targets.`;
    };
    // Only ask for band images where the API has them (avoids a 404 per target without bands).
    // Fetched at once in the background, so a search never waits on it while the API wakes.
    let catalogue = request("targets", {}, { quiet: true }).catch(() => null);
    const hasBands = async key => {
        const known = findTarget(key)?.bands;
        if (typeof known === "boolean") return known;
        catalogue = (await catalogue) ? catalogue : request("targets", {}).catch(() => null);
        const entry = (await catalogue)?.find?.(t => t.key === key);
        return entry ? entry.has_bands !== false : true;
    };
    const back = document.getElementById("back-to-sky");
    if (!form || !mode || !status || !viewer) return;

    const say = text => { status.classList.remove("is-waking"); status.textContent = text; status.hidden = !text; };
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
        offlineSeen = false;
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
            // Answered from the frontend's offline copy while the live service sleeps: say so, quietly.
            const detail = document.getElementById("target-detail");
            if (frames && offlineSeen && detail) detail.textContent += " · saved copy";
        } catch (error) {
            if (error?.name === "AbortError") return;
            say(friendly(error, label));
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
