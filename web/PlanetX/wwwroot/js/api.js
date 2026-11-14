// Browser ES module. Import from a <script type="module"> entry point.
export const API_BASE_URL = 'https://spherex-api-cpln.onrender.com/';
export const CACHED_TARGETS = Object.freeze([
    'barnards-star', 'wise-0855-0714', 'eps-ind-b', 'rw-aurigae', 'r-draconis'
]);

export class ApiError extends Error {
    constructor(message, status = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

export function createApi({ baseUrl = API_BASE_URL, timeoutMs = 30000 } = {}) {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) throw new TypeError('Invalid API base URL.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid timeout.');

    function absoluteUrl(path) {
        if (typeof path !== 'string' || !path.trim()) throw new ApiError('Missing image URL.');
        const url = new URL(path, base);
        if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('Invalid image URL.');
        return url.href;
    }
    function endpoint(path, params = {}) {
        const url = new URL(path, base);
        url.search = new URLSearchParams(params).toString();
        return url.href;
    }
    function checkTarget(target) {
        if (!CACHED_TARGETS.includes(target)) throw new TypeError(`Unsupported cached target: ${target}`);
    }
    function diffUrl(target, a = 0, b = 1) {
        checkTarget(target);
        if (![a, b].every(value => Number.isInteger(value) && value >= 0) || a === b)
            throw new TypeError('Difference indices must be distinct non-negative integers.');
        return endpoint('diff', { target, a, b });
    }

    async function request(url, { signal } = {}, asImage = false) {
        const controller = new AbortController();
        let timedOut = false;
        const cancel = () => controller.abort();
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 300);
                throw new ApiError(`API HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
            }
            if (asImage) {
                if (!response.headers.get('content-type')?.startsWith('image/'))
                    throw new ApiError('Expected a difference image.');
                return await response.blob();
            }
            return await response.json();
        } catch (error) {
            if (timedOut) throw new ApiError('API request timed out. Please retry.');
            if (controller.signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
            if (error instanceof ApiError) throw error;
            throw new ApiError(`Unable to read API response: ${error.message}`);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
        }
    }

    return {
        absoluteUrl,
        getHealth(options) { return request(endpoint('health'), options); },
        async getTargets(options) {
            const targets = await request(endpoint('targets'), options);
            if (!Array.isArray(targets)) throw new ApiError('Expected a target list.');
            return targets.filter(target => CACHED_TARGETS.includes(target.key)).map(target => ({
                ...target,
                frames_url: endpoint('frames', { target: target.key })
            }));
        },
        async getFrames(target, options) {
            checkTarget(target);
            const data = await request(endpoint('frames', { target }), options);
            if (!Array.isArray(data.frames) || !data.frames.length) throw new ApiError('No frames returned.');
            const normalizeImage = item => {
                const url = absoluteUrl(item.png_url || item.url);
                return { ...item, url, png_url: url };
            };
            return {
                ...data,
                frames: data.frames.map(normalizeImage),
                diffs: Array.isArray(data.diffs) ? data.diffs.map(normalizeImage) : []
            };
        },
        async getSpectrum(target, options) {
            checkTarget(target);
            const data = await request(endpoint('spectrum', { target }), options);
            if (!Array.isArray(data.spectrum)) throw new ApiError('Invalid spectrum response.');
            return { ...data, spectrum: data.spectrum.filter(point =>
                Number.isFinite(point.wavelength_um) && Number.isFinite(point.flux)
            ).sort((a, b) => a.wavelength_um - b.wavelength_um) };
        },
        async getFramesByDetector(target, options) {
            checkTarget(target);
            const data = await request(endpoint('frames_by_detector', { target }), options);
            if (!Array.isArray(data.detectors)) throw new ApiError('Invalid detector response.');
            return { ...data, detectors: data.detectors.map(item => ({
                ...item, png_url: absoluteUrl(item.png_url || item.url),
                ...(item.png_url_native ? { png_url_native: absoluteUrl(item.png_url_native) } : {})
            })), ...(data.png_url_color ? { png_url_color: absoluteUrl(data.png_url_color) } : {}) };
        },
        getDiffUrl: diffUrl,
        // Returns a Blob. If displayed via URL.createObjectURL, revoke that URL when done.
        getDiff(target, a = 0, b = 1, options) {
            return request(diffUrl(target, a, b), options, true);
        },
        async resolveName(name, options) {
            if (typeof name !== 'string' || !name.trim()) throw new TypeError('Enter a target name.');
            const result = await request(endpoint('resolve', { name: name.trim() }), options);
            if (!Number.isFinite(result.ra) || !Number.isFinite(result.dec))
                throw new ApiError('Invalid coordinates returned.');
            return result;
        }
    };
}

export const api = createApi();
