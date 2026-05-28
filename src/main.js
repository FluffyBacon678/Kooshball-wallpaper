/**
 * Marimo Wallpaper — entry point.
 *
 * Boot sequence:
 *   1. Create scene, camera, renderer.
 *   2. Build the central body (rigid-body sphere) and the fur system.
 *   3. Wire input (resize, mouse, visibility).
 *   4. Wire Wallpaper Engine properties (replays anything buffered before now).
 *   5. Start the rAF loop, throttled by PerformanceLimiter.
 *
 * The whole runtime lives behind `Marimo.app` for easy console inspection.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    function boot() {
        const canvas = document.getElementById("marimo-canvas");
        const overlay = document.getElementById("debug-overlay");
        if (!canvas) { console.error("[marimo] canvas missing!"); return; }
        if (typeof THREE === "undefined") {
            console.error("[marimo] Three.js failed to load — check lib/three.min.js");
            return;
        }

        const sceneCtx = Marimo.setupScene(canvas);
        const scene = sceneCtx.scene;
        const camera = sceneCtx.camera;
        const renderer = sceneCtx.renderer;

        const limiter = new Marimo.PerformanceLimiter();
        const ball = new Marimo.MarimoBall(scene, { radius: 5 });
        const fur = new Marimo.FurSystem(scene, ball, {
            quality: "medium",
            hairAmount: 1.0,
            hairLength: 4.0,
            hairVolume: 0.7,
            // Hair gravity is set by the unified Gravity slider via the
            // property bridge. We start at the slider default so the marimo
            // looks right in a non-Wallpaper-Engine browser preview too.
            gravity: 0.6,
            windStrength: 0
        });

        // ---- Soft floor "shadow" vignette under the marimo. ----
        // We rebuild the disc when the ball size changes so its scale tracks
        // the marimo's silhouette.
        const groundGroup = new THREE.Group();
        scene.add(groundGroup);
        let groundMesh = null;
        function buildGround() {
            if (groundMesh) {
                groundGroup.remove(groundMesh);
                groundMesh.geometry.dispose();
                groundMesh.material.dispose();
            }
            const seg = 64;
            const r = ball.baseRadius * 2.2;
            const geom = new THREE.CircleGeometry(r, seg);
            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true,
                depthWrite: false,
                color: 0xffffff,
                blending: THREE.MultiplyBlending,
                fog: false
            });
            const pos = geom.attributes.position;
            const colors = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                const x = pos.getX(i), y = pos.getY(i);
                const d = Math.min(1, Math.sqrt(x * x + y * y) / r);
                const v = 1.0 - Math.pow(1 - d, 2.5) * 0.55;
                colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
            }
            geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            groundMesh = new THREE.Mesh(geom, mat);
            groundMesh.rotation.x = -Math.PI / 2;
            groundMesh.renderOrder = -1;
            groundGroup.add(groundMesh);
        }
        buildGround();

        function setGroundVisible(v) { groundGroup.visible = !!v; }

        // ---- Auto-fit camera + bounds. ----
        // We compute the visible half-extent at the ball's z-plane from the
        // camera's frustum, then hand both that and the camera distance to
        // the ball so it can clamp its motion to the visible frame.
        let cameraZoom = 1.0;
        function refit() {
            const w = window.innerWidth, h = window.innerHeight;
            if (!w || !h) return;   // window not sized yet — will retry on resize

            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            const frameR = ball.baseRadius + fur._hairLength * 1.1;
            Marimo.fitCamera(camera, frameR, cameraZoom);

            // Visible half-extents at z=0 (where the ball lives).
            const dist = camera.position.length();
            const vFov = (camera.fov * Math.PI) / 180;
            const halfH = Math.tan(vFov / 2) * dist;
            const halfW = halfH * camera.aspect;
            ball.setBounds(halfW, halfH);

            // Pin the ground disc just under the marimo's resting silhouette.
            groundGroup.position.y = ball.floorY - 0.4;
        }
        function setCameraZoom(z) {
            cameraZoom = Math.max(0.5, Math.min(2.0, z || 1.0));
            refit();
        }

        // ---- Window / canvas resize. ----
        function onResize() {
            const w = window.innerWidth, h = window.innerHeight;
            renderer.setSize(w, h, false);
            // Re-cap pixel ratio (multi-monitor moves can change DPR).
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            refit();
        }
        window.addEventListener("resize", onResize);
        onResize();
        // Browsers sometimes report 0×0 for one frame before the window has
        // been laid out — re-run after the next rAF as a safety net.
        global.requestAnimationFrame(onResize);

        // ---- Mouse interaction (click-and-hold to grab, release to throw). ----
        // Strategy:
        //   - Track the cursor in world space at the z=0 plane.
        //   - On mousedown over the ball: GRAB. Each frame we kinematically
        //     pull the ball toward the cursor and derive its velocity from
        //     the displacement.
        //   - On mouseup OR when the cursor escapes a generous release radius:
        //     RELEASE. The velocity we set during the last drag step becomes
        //     the throw velocity. A small angular kick is added so the ball
        //     tumbles/rolls instead of sliding.
        //   - Note: Wallpaper Engine forwards mouse clicks to web wallpapers
        //     by default. If the ball never grabs, double-check that mouse
        //     clicks are enabled for this wallpaper in WE.
        let mouseEnabled = true;
        const mouseWorld = new THREE.Vector3(0, 0, 0);
        let mouseHasSample = false;
        let mouseGrabbed = false;
        let mouseIsDown = false;

        function setMouseEnabled(v) {
            mouseEnabled = !!v;
            if (!mouseEnabled && mouseGrabbed) {
                mouseGrabbed = false;
                ball.grabbed = false;
            }
            if (!mouseEnabled) mouseIsDown = false;
        }

        // Project the screen-space mouse to the z=0 plane in world space.
        const _ndc = new THREE.Vector3();
        const _dir = new THREE.Vector3();
        function projectMouseToWorld(clientX, clientY, out) {
            _ndc.set(
                (clientX / window.innerWidth) * 2 - 1,
                -(clientY / window.innerHeight) * 2 + 1,
                0.5
            );
            _ndc.unproject(camera);
            _dir.copy(_ndc).sub(camera.position).normalize();
            // Parametric ray hit z=0 plane.
            const t = -camera.position.z / _dir.z;
            out.copy(camera.position).addScaledVector(_dir, t);
            return out;
        }

        function onMouseMove(ev) {
            if (!mouseEnabled) return;
            projectMouseToWorld(ev.clientX, ev.clientY, mouseWorld);
            mouseHasSample = true;
        }
        function onMouseDown(ev) {
            if (!mouseEnabled) return;
            if (ev.button !== undefined && ev.button !== 0) return;  // left button only
            projectMouseToWorld(ev.clientX, ev.clientY, mouseWorld);
            mouseHasSample = true;
            mouseIsDown = true;
        }
        function onMouseUp(ev) {
            if (ev.button !== undefined && ev.button !== 0) return;
            mouseIsDown = false;
            // The grab itself is released inside applyMouseToBall on the
            // same frame — it inspects mouseIsDown and adds an angular kick.
        }
        window.addEventListener("mousemove", onMouseMove, { passive: true });
        window.addEventListener("mousedown", onMouseDown, { passive: true });
        window.addEventListener("mouseup",   onMouseUp,   { passive: true });
        // Releasing the cursor outside the window should also drop the ball.
        window.addEventListener("blur", () => { mouseIsDown = false; });

        // Scroll wheel pushes the ball toward / away from the camera, giving
        // the user explicit 3D control. Scroll up = +Z (toward camera, gets
        // bigger). Scroll down = -Z (away from camera, gets smaller).
        function onWheel(ev) {
            if (!mouseEnabled) return;
            const dir = ev.deltaY < 0 ? 1 : -1;
            ball.applyImpulse(0, 0, dir * 2.5, 0);
        }
        window.addEventListener("wheel", onWheel, { passive: true });

        // ---- Visibility (CEF in Wallpaper Engine may pause the page). ----
        let docHidden = false;
        document.addEventListener("visibilitychange", function () {
            docHidden = document.hidden;
        });

        // ---- Debug overlay toggle. ----
        let debugVisible = false;
        function setDebugVisible(v) {
            debugVisible = !!v;
            overlay.hidden = !debugVisible;
        }
        window.addEventListener("keydown", function (e) {
            if (e.key === "d" || e.key === "D") setDebugVisible(!debugVisible);
        });

        // ---- Wire Wallpaper Engine properties. ----
        Marimo.WallpaperEngineProperties.attach({
            ball: ball,
            fur: fur,
            scene: scene,
            renderer: renderer,
            limiter: limiter,
            camera: camera,
            refit: refit,
            setMouseEnabled: setMouseEnabled,
            setDebugVisible: setDebugVisible,
            setGroundVisible: setGroundVisible,
            setCameraZoom: setCameraZoom,
            rebuildGround: buildGround
        });

        // ---- Windows accent color poll. ----
        // When the user picks "Follow Windows accent" as the color mode we
        // re-read the system accent once per second and rebuild the sampler
        // if it changed.
        let lastAccentKey = null;
        setInterval(function () {
            if (fur.getColorMode() !== "systemAccent") { lastAccentKey = null; return; }
            const a = Marimo.colorModes.getSystemAccent();
            if (!a) return;
            const key = a.r.toFixed(4) + "," + a.g.toFixed(4) + "," + a.b.toFixed(4);
            if (key === lastAccentKey) return;
            lastAccentKey = key;
            fur.refreshColorSampler();
        }, 1000);

        // ---- Main loop. ----
        let last = performance.now();
        let elapsed = 0;
        let debugAccum = 0;

        function applyMouseToBall(dt) {
            if (!mouseEnabled || !mouseHasSample) return;

            // Distance cursor → ball in world space.
            const dx = mouseWorld.x - ball.position.x;
            const dy = mouseWorld.y - ball.position.y;
            const dz = mouseWorld.z - ball.position.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            // Silhouette radius for the initial grab.
            const grabRadius = ball.baseRadius * 1.4;
            // Generous safety release radius.
            const releaseRadius = ball.baseRadius * 6.0;

            if (mouseGrabbed) {
                if (!mouseIsDown || dist > releaseRadius) {
                    mouseGrabbed = false;
                    ball.grabbed = false;
                    // Angular kick coupled to the throw direction — so the
                    // ball rolls/tumbles. We also seed a small Z velocity
                    // proportional to throw magnitude so even a pure-2D drag
                    // sends the ball into the depth axis (matches the
                    // original demo's 3D bounce feel).
                    const sx = ball.velocity.x, sy = ball.velocity.y;
                    const throwSpeed = Math.sqrt(sx * sx + sy * sy);
                    ball.angularVelocity.x +=  ball.velocity.z * 0.4 + sy * 0.25;
                    ball.angularVelocity.y += (sx + ball.velocity.z) * 0.15;
                    ball.angularVelocity.z += -sx * 0.4;
                    // Random Z impulse on hard throws — without it the ball
                    // stays in the camera plane forever.
                    ball.velocity.z += (Math.random() - 0.5) * throwSpeed * 0.35;
                    return;
                }
                // Kinematically drag the ball in X-Y. We deliberately leave
                // Z alone: any depth velocity the ball was carrying is
                // preserved through the grab, so a quick grab-release on a
                // ball that was already moving in Z keeps that motion.
                const prevX = ball.position.x;
                const prevY = ball.position.y;
                const lerp = Math.min(1, dt * 18);
                ball.position.x += (mouseWorld.x - ball.position.x) * lerp;
                ball.position.y += (mouseWorld.y - ball.position.y) * lerp;
                const invDt = 1 / Math.max(0.001, dt);
                ball.velocity.x = (ball.position.x - prevX) * invDt;
                ball.velocity.y = (ball.position.y - prevY) * invDt;
                // velocity.z untouched — physics carries it
            } else if (mouseIsDown && dist < grabRadius) {
                mouseGrabbed = true;
                ball.grabbed = true;
            }
        }

        function frame(now) {
            global.requestAnimationFrame(frame);
            if (docHidden) return;
            if (!limiter.shouldRender(now)) return;

            // Cap dt for stability — a tab-switch can produce a huge gap.
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            elapsed += dt;

            applyMouseToBall(dt);
            ball.update(dt, elapsed);
            fur.update(dt, elapsed);
            renderer.render(scene, camera);

            // Debug overlay (only when visible).
            if (debugVisible) {
                debugAccum += dt;
                if (debugAccum > 0.25) {
                    debugAccum = 0;
                    const fps = limiter.getMeasuredFps().toFixed(1);
                    const tgt = limiter.getTargetFps();
                    const hairs = fur.getActiveHairCount();
                    const p = ball.position, v = ball.velocity;
                    overlay.textContent =
                        "FPS " + fps + "  /  target " + tgt + "\n" +
                        "Hairs " + hairs + " × " + fur.getSegments() + " seg\n" +
                        "Ball pos " + p.x.toFixed(1) + "," + p.y.toFixed(1) + "," + p.z.toFixed(1) + "\n" +
                        "Ball vel " + v.x.toFixed(2) + "," + v.y.toFixed(2) + "," + v.z.toFixed(2) + "\n" +
                        "DPR " + (renderer.getPixelRatio()).toFixed(2) + "  " +
                        window.innerWidth + "×" + window.innerHeight;
                }
            }
        }
        global.requestAnimationFrame(frame);

        // Expose for console inspection.
        Marimo.app = {
            scene: scene, camera: camera, renderer: renderer,
            ball: ball, fur: fur, limiter: limiter,
            refit: refit
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
