import * as THREE from "./three.js";
import { rng } from "./util.js";

// A small tileable noise texture built on the CPU once. Shaders that run every frame
// (nebulae, galaxies, accretion disk) sample it instead of evaluating procedural noise,
// which keeps them cheap on integrated GPUs.
// R: soft fbm, G: finer fbm, B: ridged fbm (filaments), A: fbm on another seed.
export function createNoiseTexture(size = 256) {
    const data = new Uint8Array(size * size * 4);
    const channels = [
        { seed: 11, base: 4, octaves: 6, ridged: false },
        { seed: 23, base: 8, octaves: 5, ridged: false },
        { seed: 37, base: 4, octaves: 6, ridged: true },
        { seed: 53, base: 6, octaves: 5, ridged: false },
    ];

    channels.forEach((channel, c) => {
        const random = rng(channel.seed);
        const octaves = [];
        for (let o = 0; o < channel.octaves; o++) {
            const period = channel.base << o;
            const grid = new Float32Array(period * period);
            for (let i = 0; i < grid.length; i++) grid[i] = random();
            octaves.push({ period, grid });
        }
        let min = Infinity, max = -Infinity;
        const values = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let sum = 0, amp = 0.5, norm = 0;
                for (const { period, grid } of octaves) {
                    const fx = (x / size) * period, fy = (y / size) * period;
                    const ix = Math.floor(fx), iy = Math.floor(fy);
                    let tx = fx - ix, ty = fy - iy;
                    tx = tx * tx * (3 - 2 * tx);
                    ty = ty * ty * (3 - 2 * ty);
                    const x0 = ix % period, x1 = (ix + 1) % period;
                    const y0 = iy % period, y1 = (iy + 1) % period;
                    const a = grid[y0 * period + x0], b = grid[y0 * period + x1];
                    const d = grid[y1 * period + x0], e = grid[y1 * period + x1];
                    let n = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
                    if (channel.ridged) n = Math.pow(1 - Math.abs(n * 2 - 1), 2);
                    sum += n * amp;
                    norm += amp;
                    amp *= 0.5;
                }
                const v = sum / norm;
                values[y * size + x] = v;
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
        // Stretch to the full 0..1 range so shaders get useful contrast.
        for (let i = 0; i < values.length; i++) {
            data[i * 4 + c] = Math.round(((values[i] - min) / (max - min)) * 255);
        }
    });

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
}
