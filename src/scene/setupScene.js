/**
 * Builds the Three.js renderer, scene, camera, and a soft directional light.
 *
 * Notes:
 *  - PerspectiveCamera with a generous near/far so resizing & zoom can't clip.
 *  - WebGLRenderer with antialias on but pixel ratio capped at 2 — Wallpaper
 *    Engine on a 4K screen will otherwise burn GPU for no visible gain.
 *  - We auto-fit the camera distance to the ball radius and viewport aspect
 *    so the marimo stays well-framed on 16:9, 21:9, 32:9 and ultrawide setups.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    function createScene(canvas) {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x07090b);

        const camera = new THREE.PerspectiveCamera(
            32,                                         // FOV — tight enough to keep the ball "portrait"
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        camera.position.set(0, 0, 28);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
            stencil: false,
            depth: true
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        // A single soft directional light so the body sphere has subtle shading.
        // The hair colours come from the fur shader directly so the light only
        // sculpts the central ball, which keeps the look graphic & flat.
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(-1, 2, 1.5);
        scene.add(key);

        const fill = new THREE.AmbientLight(0x8ab4ff, 0.35);
        scene.add(fill);

        return {
            scene: scene,
            camera: camera,
            renderer: renderer,
            lights: { key: key, fill: fill }
        };
    }

    /**
     * Auto-fit camera distance so a sphere of `frameRadius` (ball + hair) fits
     * comfortably regardless of aspect ratio. The camera is *elevated* above
     * the marimo (matching the original Marimo demo's view from ~37° above
     * horizontal) — that angle foreshortens the gravity-induced teardrop
     * shape into a clean round silhouette while still showing the body's
     * bounce in 3D.
     */
    function fitCamera(camera, frameRadius, zoom, elevationDeg, lookAtY) {
        if (elevationDeg === undefined) elevationDeg = 22;
        if (lookAtY === undefined) lookAtY = 0;
        const aspect = camera.aspect;
        const vFov = (camera.fov * Math.PI) / 180;
        let dist = frameRadius / Math.tan(vFov / 2);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
        const distH = frameRadius / Math.tan(hFov / 2);
        dist = Math.max(dist, distH) * 1.18 * zoom;
        const rad = elevationDeg * Math.PI / 180;
        camera.position.set(0, dist * Math.sin(rad), dist * Math.cos(rad));
        camera.lookAt(0, lookAtY, 0);
    }

    Marimo.setupScene = createScene;
    Marimo.fitCamera = fitCamera;
})(window);
