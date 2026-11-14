import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const container = document.getElementById("viewer-container");

if (!container) {
    throw new Error('Could not find the element with id "viewer-container".');
}

// Make the viewer a full-page background.
Object.assign(document.documentElement.style, {
    width: "100%",
    height: "100%",
    margin: "0",
});

Object.assign(document.body.style, {
    width: "100%",
    height: "100%",
    margin: "0",
    overflow: "hidden",
    background: "#02030b",
});

Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "0",
    overflow: "hidden",
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030b);

const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
);
camera.position.set(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const canvas = renderer.domElement;
Object.assign(canvas.style, {
    display: "block",
    width: "100%",
    height: "100%",
    cursor: "grab",
    touchAction: "none",
});

// Keep foreground UI above the scene, for example:
// <div class="ui-layer">Your page content</div>
const style = document.createElement("style");
style.textContent = `
  .ui-layer {
    position: relative;
    z-index: 1;
  }
`;
document.head.appendChild(style);

// Seeded random generator keeps the scene stable between reloads.
let seed = 123456;
function random() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
}

function makeGalaxy({
    position,
    color = 0x9caeff,
    count = 12000,
    radius = 10,
    arms = 4,
    tilt = 0,
    size = 0.09,
}) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const baseColor = new THREE.Color(color);

    for (let i = 0; i < count; i++) {
        const arm = i % arms;
        const r = Math.pow(random(), 0.65) * radius;
        const armAngle =
            (arm / arms) * Math.PI * 2 + r * 0.48 + (random() - 0.5) * 0.55;
        const spread = (random() - 0.5) * (0.3 + r * 0.08);

        const x = Math.cos(armAngle) * r + spread;
        const y = Math.sin(armAngle) * r * 0.48 + spread * 0.45;
        const z = (random() - 0.5) * (0.3 + r * 0.06);

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        const brightness = 0.45 + random() * 0.8;
        colors[i * 3] = baseColor.r * brightness;
        colors[i * 3 + 1] = baseColor.g * brightness;
        colors[i * 3 + 2] = baseColor.b * brightness;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
    });

    const galaxy = new THREE.Points(geometry, material);
    galaxy.position.set(...position);
    galaxy.rotation.x = tilt;
    scene.add(galaxy);
    return galaxy;
}

function makeNebula(position, color, count = 7000, spread = 14) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const baseColor = new THREE.Color(color);

    for (let i = 0; i < count; i++) {
        // Concentrate points toward the center to create a soft cloud.
        const angle = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * spread;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r * 0.7;
        const z = (random() - 0.5) * spread * 0.55;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        const brightness = 0.25 + random() * 0.55;
        colors[i * 3] = baseColor.r * brightness;
        colors[i * 3 + 1] = baseColor.g * brightness;
        colors[i * 3 + 2] = baseColor.b * brightness;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const cloud = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
            size: 0.24,
            vertexColors: true,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: true,
        })
    );

    cloud.position.set(...position);
    scene.add(cloud);
    return cloud;
}

function makeBlackHole(position) {
    const group = new THREE.Group();
    group.position.set(...position);

    const darkCore = new THREE.Mesh(
        new THREE.SphereGeometry(2.1, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    group.add(darkCore);

    const disk = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.55, 12, 96),
        new THREE.MeshBasicMaterial({
            color: 0xff8a45,
            transparent: true,
            opacity: 0.78,
            blending: THREE.AdditiveBlending,
        })
    );
    disk.rotation.x = Math.PI / 2.5;
    group.add(disk);

    const glow = new THREE.Mesh(
        new THREE.TorusGeometry(2.55, 0.13, 8, 96),
        new THREE.MeshBasicMaterial({
            color: 0xffd49a,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
        })
    );
    glow.rotation.x = Math.PI / 2.5;
    group.add(glow);

    scene.add(group);
    return group;
}

// Place the objects around the origin, mostly in front of the initial view.
const milkyWay = makeGalaxy({
    position: [-18, 8, -58],
    color: 0xa8c2ff,
    count: 18000,
    radius: 13,
    arms: 5,
    tilt: 0.32,
    size: 0.085,
});

const andromeda = makeGalaxy({
    position: [31, -10, -92],
    color: 0xffc6a2,
    count: 14000,
    radius: 11,
    arms: 4,
    tilt: -0.55,
    size: 0.09,
});

const nebulae = [
    makeNebula([12, 16, -42], 0x613fff, 6000, 12),
    makeNebula([-35, -13, -76], 0x159dff, 7000, 16),
    makeNebula([42, 18, -125], 0xff3f8f, 6500, 18),
];

const blackHole = makeBlackHole([5, -5, -38]);

// Distant stars.
const starCount = 9000;
const starPositions = new Float32Array(starCount * 3);

for (let i = 0; i < starCount; i++) {
    const distance = 120 + random() * 900;
    const theta = random() * Math.PI * 2;
    const vertical = random() * 2 - 1;
    const horizontal = Math.sqrt(1 - vertical * vertical);

    starPositions[i * 3] = distance * horizontal * Math.cos(theta);
    starPositions[i * 3 + 1] = distance * vertical;
    starPositions[i * 3 + 2] = distance * horizontal * Math.sin(theta);
}

const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3)
);

const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
        color: 0xdce8ff,
        size: 0.55,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        sizeAttenuation: true,
    })
);
scene.add(stars);

function makeStarGlowTexture() {
    const size = 64;
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = size;
    glowCanvas.height = size;

    const context = glowCanvas.getContext("2d");
    const gradient = context.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2
    );
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.2, "rgba(255, 255, 255, 0.85)");
    gradient.addColorStop(0.5, "rgba(255, 238, 205, 0.28)");
    gradient.addColorStop(1, "rgba(255, 238, 205, 0)");

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(glowCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// Five prominent stars at random positions, reserved for the stars that will
// be highlighted in the foreground UI.
const emphasisStarCount = 5;
const emphasisStarPositions = new Float32Array(emphasisStarCount * 3);
const emphasisStarColors = new Float32Array(emphasisStarCount * 3);
const emphasisPalette = [0xfff6df, 0xffe4b0, 0xd8e8ff, 0xffd2c0, 0xf2e6ff];

for (let i = 0; i < emphasisStarCount; i++) {
    const distance = 30 + random() * 70;

    emphasisStarPositions[i * 3] = (random() - 0.5) * distance * 1.1;
    emphasisStarPositions[i * 3 + 1] = (random() - 0.5) * distance * 0.6;
    emphasisStarPositions[i * 3 + 2] = -distance;

    const color = new THREE.Color(emphasisPalette[i % emphasisPalette.length]);
    emphasisStarColors[i * 3] = color.r;
    emphasisStarColors[i * 3 + 1] = color.g;
    emphasisStarColors[i * 3 + 2] = color.b;
}

const emphasisStarGeometry = new THREE.BufferGeometry();
emphasisStarGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(emphasisStarPositions, 3)
);
emphasisStarGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(emphasisStarColors, 3)
);

const starGlowTexture = makeStarGlowTexture();

const emphasisStars = new THREE.Points(
    emphasisStarGeometry,
    new THREE.PointsMaterial({
        map: starGlowTexture,
        size: 3.8,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
    })
);
scene.add(emphasisStars);

const emphasisStarHalos = new THREE.Points(
    emphasisStarGeometry,
    new THREE.PointsMaterial({
        map: starGlowTexture,
        color: 0xffd9a0,
        size: 10,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
    })
);
scene.add(emphasisStarHalos);

// Drag with the left mouse button to look around.
let dragging = false;
let previousX = 0;
let previousY = 0;
// Positive yaw means the camera is turned to the right.
let yaw = 0;
let pitch = 0;

const maxPitch = Math.PI / 2 - 0.02;
const dragSensitivity = 0.004;

canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    dragging = true;
    previousX = event.clientX;
    previousY = event.clientY;
    canvas.style.cursor = "grabbing";
    canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;

    const deltaX = event.clientX - previousX;
    const deltaY = event.clientY - previousY;
    previousX = event.clientX;
    previousY = event.clientY;

    // Drag right -> look right. Three.js treats positive rotation.y as a
    // counter-clockwise turn (to the left), so apply yaw with the opposite sign.
    yaw += deltaX * dragSensitivity;
    pitch -= deltaY * dragSensitivity;
    pitch = THREE.MathUtils.clamp(pitch, -maxPitch, maxPitch);

    camera.rotation.order = "YXZ";
    camera.rotation.y = -yaw;
    camera.rotation.x = pitch;
});

function stopDragging() {
    dragging = false;
    canvas.style.cursor = "grab";
}

canvas.addEventListener("pointerup", stopDragging);
canvas.addEventListener("pointercancel", stopDragging);
canvas.addEventListener("lostpointercapture", stopDragging);

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const elapsed = clock.getElapsedTime();
    milkyWay.rotation.z = 0.32 + elapsed * 0.003;
    andromeda.rotation.z = -0.55 - elapsed * 0.002;
    blackHole.rotation.z = elapsed * 0.12;
    nebulae.forEach((cloud, index) => {
        cloud.rotation.z = elapsed * (index % 2 ? -0.002 : 0.002);
    });

    renderer.render(scene, camera);
}

animate();
