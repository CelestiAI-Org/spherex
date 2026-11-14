// Simple 2D starfield used when WebGL2 isn't available, so the page never shows a blank sky.
export function startFallback(container) {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let stars = [];
    function resize() {
        const dpr = Math.min(devicePixelRatio || 1, 1.5);
        canvas.width = innerWidth * dpr;
        canvas.height = innerHeight * dpr;
        let seed = 7;
        const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        stars = Array.from({ length: Math.round((canvas.width * canvas.height) / 2500) }, () => ({
            x: random() * canvas.width, y: random() * canvas.height,
            r: Math.pow(random(), 6) * 2.2 * dpr + 0.4, phase: random() * 6.28,
            hue: random() < 0.3 ? "255,210,170" : random() < 0.6 ? "200,215,255" : "255,250,240",
        }));
    }
    function draw(t) {
        const { width: w, height: h } = canvas;
        const bg = ctx.createRadialGradient(w * 0.62, h * 0.55, 0, w * 0.62, h * 0.55, Math.max(w, h) * 0.7);
        bg.addColorStop(0, "#1a1030");
        bg.addColorStop(0.45, "#0a0c1e");
        bg.addColorStop(1, "#02030b");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        const band = ctx.createLinearGradient(0, h, w, 0);
        band.addColorStop(0.3, "rgba(0,0,0,0)");
        band.addColorStop(0.5, "rgba(150,160,210,0.10)");
        band.addColorStop(0.7, "rgba(0,0,0,0)");
        ctx.fillStyle = band;
        ctx.fillRect(0, 0, w, h);
        for (const s of stars) {
            const a = 0.55 + 0.45 * Math.sin(t / 900 + s.phase);
            ctx.fillStyle = `rgba(${s.hue},${a})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, 6.283);
            ctx.fill();
        }
        setTimeout(() => requestAnimationFrame(draw), 33);
    }
    resize();
    addEventListener("resize", resize);
    requestAnimationFrame(draw);
}
