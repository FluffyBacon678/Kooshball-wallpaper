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
        const rgbBars = {
            bottom: document.getElementById("rgb-sync-bottom"),
            top:    document.getElementById("rgb-sync-top"),
            left:   document.getElementById("rgb-sync-left"),
            right:  document.getElementById("rgb-sync-right")
        };
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
            // Defaults match the original Marimo demo (Main.hx).
            hairLength: 3.0,
            hairVolume: 0.6,
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
        // Elevated camera ~28° above horizontal, target slightly below the
        // ball's settled position — visually matches the original demo's
        // angle of view and hides the natural teardrop of a gravity-loaded
        // hair ball.
        const CAMERA_ELEVATION_DEG = 28;
        const CAMERA_LOOK_AT_Y = -2.0;
        let cameraZoom = 1.0;
        function refit() {
            const w = window.innerWidth, h = window.innerHeight;
            if (!w || !h) return;   // window not sized yet — will retry on resize

            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            const frameR = ball.baseRadius + fur._hairLength * 1.1;
            Marimo.fitCamera(camera, frameR, cameraZoom,
                CAMERA_ELEVATION_DEG, CAMERA_LOOK_AT_Y);

            // Visible half-extents — used by ball.setBounds. Compute at the
            // target Y so the ball can use the full visible frame without
            // bouncing off invisible walls.
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
        const mouseWorldPrev = new THREE.Vector3(0, 0, 0);
        let mouseHasSample = false;
        let mouseGrabbed = false;
        let mouseIsDown = false;
        // "Mouse breeze": gently nudge the ball with mouse movement even when
        // the cursor isn't over (grabbing) the ball. Toggled by a user prop.
        let mouseFollow = false;

        function setMouseEnabled(v) {
            mouseEnabled = !!v;
            if (!mouseEnabled && mouseGrabbed) {
                mouseGrabbed = false;
                ball.grabbed = false;
            }
            if (!mouseEnabled) mouseIsDown = false;
        }
        function setMouseFollow(v) { mouseFollow = !!v; }

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

        // ---- RGB sync (iCUE / Razer / Aurora). ----
        // Three layouts:
        //   off       — bars hidden, no work each frame
        //   bottom    — single bar at the bottom edge (minimum visual impact)
        //   ambilight — all four edges, four sample regions for richer sync
        //
        // Screen-sampling RGB hardware software (iCUE Murals, Aurora, Razer
        // Synapse Chroma Studio) can target these regions and mirror the
        // color onto user devices in real time — no native plugin needed.
        let rgbSyncLayout = "off";
        let rgbBarAccum = 0;
        function setRgbSync(layout) {
            rgbSyncLayout = String(layout || "off");
            const show = function (id, on) {
                if (rgbBars[id]) rgbBars[id].hidden = !on;
            };
            show("bottom", rgbSyncLayout === "bottom" || rgbSyncLayout === "ambilight");
            show("top",    rgbSyncLayout === "ambilight");
            show("left",   rgbSyncLayout === "ambilight");
            show("right",  rgbSyncLayout === "ambilight");
        }
        function updateRgbSyncBars(dt) {
            if (rgbSyncLayout === "off") return;
            // Throttle to ~30 Hz — DOM style writes are expensive at 60+ Hz.
            rgbBarAccum += dt;
            if (rgbBarAccum < 0.033) return;
            rgbBarAccum = 0;
            const sampler = fur._colorSampler;
            if (!sampler) return;
            const c = sampler(0.9, 0, elapsed);
            if (!c) return;
            const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
            const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
            const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
            const css = "rgb(" + r + "," + g + "," + b + ")";
            // Update only the currently-visible bars.
            if (rgbBars.bottom && !rgbBars.bottom.hidden) rgbBars.bottom.style.backgroundColor = css;
            if (rgbSyncLayout === "ambilight") {
                if (rgbBars.top)   rgbBars.top.style.backgroundColor   = css;
                if (rgbBars.left)  rgbBars.left.style.backgroundColor  = css;
                if (rgbBars.right) rgbBars.right.style.backgroundColor = css;
            }
        }

        // ---- Audio reactivity (Wallpaper Engine forwards system audio). ----
        // Wallpaper Engine calls our registered callback with a Float32Array
        // of 128 magnitudes (64 per channel, low→high frequency). We extract
        // bass and treble bands and apply them as ball impulses and a
        // transient wind boost — the marimo "dances" to music.
        let audioReactivity = 0.0;
        let audioBassLevel = 0;
        let audioTrebleLevel = 0;
        function setAudioReactivity(v) {
            audioReactivity = Math.max(0, Math.min(2, Number(v) || 0));
        }
        if (typeof global.wallpaperRegisterAudioListener === "function") {
            global.wallpaperRegisterAudioListener(function (audioData) {
                if (!audioData || audioReactivity <= 0) return;
                // Sum the lowest 6 bins from each channel (bass), highest 6 (treble).
                let bass = 0, treble = 0;
                for (let i = 0; i < 6; i++) {
                    bass   += audioData[i] + audioData[64 + i];
                    treble += audioData[58 + i] + audioData[122 + i];
                }
                bass   /= 12;   // normalize
                treble /= 12;
                // Light low-pass smoothing — raw audio bins are jittery.
                audioBassLevel   = audioBassLevel   * 0.55 + bass   * 0.45;
                audioTrebleLevel = audioTrebleLevel * 0.55 + treble * 0.45;
            });
        }
        function applyAudioToBall() {
            if (audioReactivity <= 0) return;
            const k = audioReactivity;
            // Bass → upward impulse (the marimo "jumps" on heavy bass beats).
            if (audioBassLevel > 0.05) {
                ball.applyImpulse(0, audioBassLevel * 4 * k, 0, 0);
            }
            // Treble → bonus angular kick around Y so the body spins
            // slightly with high-frequency content.
            if (audioTrebleLevel > 0.05) {
                ball.angularVelocity.y += audioTrebleLevel * 0.4 * k;
            }
        }

        // ---- Pause detection (Wallpaper Engine sends `paused` general prop). ----
        // When WE pauses the wallpaper (fullscreen game/video) we skip both
        // simulation and rendering — saves CPU + GPU until the user
        // alt-tabs back.
        let paused = false;
        function setPaused(v) { paused = !!v; }

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
            setMouseFollow: setMouseFollow,
            setDvdMode: function (v) { ball.setDvdMode(v); },
            setDvdSpeed: function (v) { ball.setDvdSpeed(v); },
            setDebugVisible: setDebugVisible,
            setGroundVisible: setGroundVisible,
            setCameraZoom: setCameraZoom,
            rebuildGround: buildGround,
            setRgbSync: setRgbSync,
            setAudioReactivity: setAudioReactivity,
            setPaused: setPaused
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
                } else {
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
                }
            } else if (mouseIsDown && dist < grabRadius) {
                mouseGrabbed = true;
                ball.grabbed = true;
            } else if (mouseFollow) {
                // Mouse breeze: convert this frame's cursor movement into a
                // light impulse on the ball, even though it isn't grabbed.
                // Clamped so a fast flick across the screen can't launch it.
                const mvx = THREE.MathUtils.clamp(mouseWorld.x - mouseWorldPrev.x, -4, 4);
                const mvy = THREE.MathUtils.clamp(mouseWorld.y - mouseWorldPrev.y, -4, 4);
                ball.applyImpulse(mvx * 0.22, mvy * 0.22, 0, 0.008);
            }

            // Track cursor world position for the next frame's breeze delta.
            mouseWorldPrev.copy(mouseWorld);
        }

        // ---- Keep the ball inside the visible frame (hard guarantee). ----
        // The world-space walls give a nice bounce, but with a perspective
        // camera + hair extending past the body radius they aren't an exact
        // screen boundary. This projects the ball to screen space (NDC) and,
        // using a hair-aware margin, pulls it back so its fuzzy silhouette can
        // never leave the screen — regardless of grab, throw, scroll-depth or
        // audio. Runs every frame after the ball has moved.
        const _clProj = new THREE.Vector3();
        const _clTmp  = new THREE.Vector3();
        const _clTgt  = new THREE.Vector3();
        // The 6 extreme surface offsets of the fuzzy ball (along world axes).
        // Projecting all 6 captures the true perspective silhouette — the
        // toward-camera point projects largest — so the box is exact, not an
        // approximation.
        const _clAxes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        function clampBallToViewport() {
            const visR = ball.baseRadius + fur._hairLength * 1.15;
            _clProj.copy(ball.position).project(camera);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = 0; k < 6; k++) {
                const a = _clAxes[k];
                _clTmp.set(
                    ball.position.x + a[0] * visR,
                    ball.position.y + a[1] * visR,
                    ball.position.z + a[2] * visR
                ).project(camera);
                if (_clTmp.x < minX) minX = _clTmp.x;
                if (_clTmp.x > maxX) maxX = _clTmp.x;
                if (_clTmp.y < minY) minY = _clTmp.y;
                if (_clTmp.y > maxY) maxY = _clTmp.y;
            }
            // Asymmetric extents from center to each silhouette edge (NDC),
            // with a tiny safety pad. Clamp the center so every edge stays
            // inside [-1, 1].
            const S = 1.06;
            let leftE  = (_clProj.x - minX) * S;
            let rightE = (maxX - _clProj.x) * S;
            let downE  = (_clProj.y - minY) * S;
            let upE    = (maxY - _clProj.y) * S;
            // If the ball is too big to fit on an axis, center it there.
            if (leftE + rightE >= 2) { leftE = rightE = 0.999; }
            if (downE + upE     >= 2) { downE = upE     = 0.999; }
            let nx = _clProj.x, ny = _clProj.y, hitX = 0, hitY = 0;
            if (nx - leftE < -1)      { nx = -1 + leftE;  hitX = -1; }
            else if (nx + rightE > 1) { nx =  1 - rightE; hitX =  1; }
            if (ny - downE < -1)      { ny = -1 + downE;  hitY = -1; }
            else if (ny + upE > 1)    { ny =  1 - upE;    hitY =  1; }
            if (!hitX && !hitY) return;
            // DVD mode bounces losslessly (perfect reflection) so the drift
            // never decays; otherwise use the ball's restitution.
            const e = ball.dvdMode ? 1 : ball.restitution;
            _clTgt.set(nx, ny, _clProj.z).unproject(camera);
            if (hitX) {
                ball.position.x = _clTgt.x;
                if ((hitX < 0 && ball.velocity.x < 0) || (hitX > 0 && ball.velocity.x > 0)) {
                    ball.velocity.x *= -e;
                }
            }
            if (hitY) {
                ball.position.y = _clTgt.y;
                if ((hitY < 0 && ball.velocity.y < 0) || (hitY > 0 && ball.velocity.y > 0)) {
                    ball.velocity.y *= -e;
                }
            }
            // Re-sync the body mesh to the corrected position (ball.update
            // already copied the pre-clamp position into the mesh).
            ball.mesh.position.copy(ball.position);
        }

        function frame(now) {
            global.requestAnimationFrame(frame);
            if (docHidden || paused) return;
            if (!limiter.shouldRender(now)) return;

            // Cap dt for stability — a tab-switch can produce a huge gap.
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            elapsed += dt;

            applyMouseToBall(dt);
            applyAudioToBall();
            ball.update(dt, elapsed);
            clampBallToViewport();   // hard on-screen guarantee, before hair reads position
            fur.update(dt, elapsed);
            renderer.render(scene, camera);
            updateRgbSyncBars(dt);

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
