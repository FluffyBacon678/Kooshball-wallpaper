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
        const bloom = new Marimo.Bloom(renderer);
        let bloomEnabled = false;
        const ball = new Marimo.MarimoBall(scene, { radius: 4 });
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

        // Per-frame: the soft shadow follows the ball horizontally and grows
        // + fades as the ball rises, so it reads as cast by the ball rather
        // than a fixed disc at the origin. (y stays pinned to the floor by
        // refit(); we only move x/z and scale here.)
        function updateGroundShadow() {
            if (!groundGroup.visible) return;
            groundGroup.position.x = ball.position.x;
            groundGroup.position.z = ball.position.z * 0.5; // depth foreshortened
            const restY = ball.floorY + ball.baseRadius;
            const h = Math.max(0, ball.position.y - restY);
            const hN = Math.min(1, h / (ball.baseRadius * 3.5));
            // Higher ball → larger + fainter shadow. With MultiplyBlending the
            // darkness is the disc colour, so we lighten it toward white
            // (>1 pushes the dark vertex colours up, fading the shadow).
            const s = 1 + hN * 0.7;
            groundGroup.scale.set(s, 1, s);
            if (groundMesh) groundMesh.material.color.setScalar(1 + hN * 1.3);
        }

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
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(dpr);
            // Bloom render targets work in device pixels — only (re)allocated
            // while bloom is actually enabled (no idle GPU memory when off).
            if (bloomEnabled) bloom.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
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
        let mouseClientX = 0, mouseClientY = 0;   // raw cursor, reprojected each frame
        // "Mouse breeze": gently nudge the ball with mouse movement even when
        // the cursor isn't over (grabbing) the ball. Toggled by a user prop.
        let mouseFollow = false;
        // "Mouse moves ball": the cursor acts like a small solid that bats /
        // pushes the ball when it moves into it — no clicking/grabbing needed.
        let mousePush = false;

        function setMouseEnabled(v) {
            mouseEnabled = !!v;
            if (!mouseEnabled && mouseGrabbed) {
                mouseGrabbed = false;
                ball.grabbed = false;
            }
            if (!mouseEnabled) mouseIsDown = false;
        }
        function setMouseFollow(v) { mouseFollow = !!v; }
        function setMousePush(v) { mousePush = !!v; }

        // Project the screen-space cursor onto an arbitrary world plane z=planeZ.
        // Using the ball's current z (instead of a fixed z=0) keeps grab/drag
        // correct even when the ball has rolled toward or away from the camera.
        const _ndc = new THREE.Vector3();
        const _dir = new THREE.Vector3();
        function projectMouseToWorld(clientX, clientY, planeZ, out) {
            _ndc.set(
                (clientX / window.innerWidth) * 2 - 1,
                -(clientY / window.innerHeight) * 2 + 1,
                0.5
            );
            _ndc.unproject(camera);
            _dir.copy(_ndc).sub(camera.position).normalize();
            const t = (planeZ - camera.position.z) / _dir.z;
            out.copy(camera.position).addScaledVector(_dir, t);
            return out;
        }

        // Perpendicular distance from the ball centre to the picking ray —
        // a depth-independent "is the cursor over the ball?" test, so a ball
        // far from the camera is still grabbable when you click on it.
        const _rayV = new THREE.Vector3();
        function mouseRayDistanceToBall() {
            _ndc.set(
                (mouseClientX / window.innerWidth) * 2 - 1,
                -(mouseClientY / window.innerHeight) * 2 + 1,
                0.5
            );
            _ndc.unproject(camera);
            _dir.copy(_ndc).sub(camera.position).normalize();
            _rayV.copy(ball.position).sub(camera.position);
            const t = _rayV.dot(_dir);
            // closest point on ray = camera + dir*t; distance to ball centre:
            _rayV.copy(camera.position).addScaledVector(_dir, t).sub(ball.position);
            return _rayV.length();
        }

        function onMouseMove(ev) {
            // Track the cursor regardless of the grab toggle so the "mouse
            // moves ball" / breeze effects can work on their own switches.
            mouseClientX = ev.clientX; mouseClientY = ev.clientY;
            mouseHasSample = true;
        }
        function onMouseDown(ev) {
            if (!mouseEnabled) return;
            if (ev.button !== undefined && ev.button !== 0) return;  // left button only
            mouseClientX = ev.clientX; mouseClientY = ev.clientY;
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
        // WE calls our callback with a Float32Array of 128 magnitudes (64 per
        // channel, low→high frequency). We split bass / mid / treble and an
        // overall level, smooth them, and drive several independent reactions
        // the user can toggle:
        //   bounce — bass jumps the ball, treble spins it
        //   pulse  — overall level pulses the ball's size
        //   glow   — overall level brightens the fur
        //   hair   — bass puffs the fur out (stands on end on beats)
        let audioReactivity = 0.0;     // master sensitivity
        const audio = { bass: 0, mid: 0, treble: 0, level: 0 };
        const audioReact = { bounce: true, pulse: false, glow: false, hair: false };
        function setAudioReactivity(v) { audioReactivity = Math.max(0, Math.min(3, Number(v) || 0)); }
        function setAudioReact(key, v) { if (key in audioReact) audioReact[key] = !!v; }

        if (typeof global.wallpaperRegisterAudioListener === "function") {
            global.wallpaperRegisterAudioListener(function (data) {
                if (!data || audioReactivity <= 0) return;
                let bass = 0, mid = 0, treble = 0, level = 0;
                for (let i = 0; i < 8; i++) { bass   += data[i] + data[64 + i]; }
                for (let i = 24; i < 32; i++) { mid    += data[i] + data[64 + i]; }
                for (let i = 56; i < 64; i++) { treble += data[i] + data[64 + i]; }
                for (let i = 0; i < 64; i++) { level  += data[i] + data[64 + i]; }
                bass /= 16; mid /= 16; treble /= 16; level /= 128;
                // Low-pass smoothing — raw bins are jittery.
                audio.bass   = audio.bass   * 0.5 + bass   * 0.5;
                audio.mid    = audio.mid    * 0.5 + mid    * 0.5;
                audio.treble = audio.treble * 0.5 + treble * 0.5;
                audio.level  = audio.level  * 0.6 + level  * 0.4;
            });
        }

        function applyAudio() {
            const k = audioReactivity;
            if (k <= 0) {
                // Make sure transient effects relax to zero when disabled.
                ball.setAudioScale(0); fur.setAudioGlow(0); fur.setAudioPuff(0);
                return;
            }
            if (audioReact.bounce) {
                if (audio.bass > 0.05)   ball.applyImpulse(0, audio.bass * 4 * k, 0, 0);
                if (audio.treble > 0.05) ball.angularVelocity.y += audio.treble * 0.4 * k;
            }
            // Pulse / glow / hair ease toward their target each frame so they
            // don't flicker; targets are 0 when their toggle is off.
            ball.setAudioScale(audioReact.pulse ? Math.min(0.4, audio.level * 0.8 * k) : 0);
            fur.setAudioGlow(audioReact.glow  ? Math.min(1.5, audio.level * 1.6 * k) : 0);
            fur.setAudioPuff(audioReact.hair  ? Math.min(0.5, audio.bass  * 0.6 * k) : 0);
        }

        // ---- Pause detection (Wallpaper Engine sends `paused` general prop). ----
        // When WE pauses the wallpaper (fullscreen game/video) we skip both
        // simulation and rendering — saves CPU + GPU until the user
        // alt-tabs back.
        let paused = false;
        function setPaused(v) { paused = !!v; }

        // Adaptive-quality state — declared before attach() because the
        // initial property replay can call setAdaptiveQuality synchronously
        // (the controller logic itself lives further down).
        let adaptiveEnabled = true;
        let adaptiveScale = 1.0;
        let workEMA = 6;          // ms, EMA of per-frame CPU work
        let adaptAccum = 0;
        function setAdaptiveQuality(v) {
            adaptiveEnabled = !!v;
            if (!adaptiveEnabled) { adaptiveScale = 1.0; fur.setAdaptiveScale(1.0); }
        }

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
            setMousePush: setMousePush,
            setDvdMode: function (v) { ball.setDvdMode(v); },
            setDvdSpeed: function (v) { ball.setDvdSpeed(v); },
            setIdleDrift: function (v) { ball.setIdleDrift(v); },
            setIdleDriftSpeed: function (v) { ball.setIdleDriftSpeed(v); },
            setDebugVisible: setDebugVisible,
            setGroundVisible: setGroundVisible,
            setCameraZoom: setCameraZoom,
            rebuildGround: buildGround,
            setRgbSync: setRgbSync,
            setAudioReactivity: setAudioReactivity,
            setAudioReact: setAudioReact,
            setColorCycleSpeed: function (v) { fur.setColorCycleSpeed(v); },
            setRgbSpeed: function (v) { fur.setRgbSpeed(v); },
            setBrightness: function (v) { fur.setBrightness(v); },
            setAdaptiveQuality: setAdaptiveQuality,
            setBloom: function (v) {
                bloomEnabled = !!v;
                // Allocate the bloom targets the moment it's switched on.
                if (bloomEnabled) {
                    const dpr = Math.min(window.devicePixelRatio || 1, 2);
                    bloom.setSize(Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));
                }
            },
            setBloomStrength: function (v) { bloom.setStrength(v); },
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
            if (!mouseHasSample) return;
            if (!mouseEnabled && !mousePush && !mouseFollow) return;

            // Project the cursor onto the ball's CURRENT depth plane so drag
            // tracking, push and breeze work no matter how far the ball has
            // travelled toward/away from the camera.
            projectMouseToWorld(mouseClientX, mouseClientY, ball.position.z, mouseWorld);

            // Grab test uses the perpendicular distance from the ball centre
            // to the picking ray — depth-independent, so a far ball is still
            // grabbable.
            const rayDist = mouseRayDistanceToBall();
            const grabRadius = ball.baseRadius * 1.5;

            if (mouseGrabbed) {
                // Release ONLY on mouse-up. We used to also release when the
                // ball-to-cursor distance exceeded a threshold, but during a
                // very fast drag the ball lerps behind the cursor and that gap
                // tripped a false release ("the mouse let go"). While the
                // button is held, keep holding no matter how fast you swing.
                if (!mouseIsDown) {
                    mouseGrabbed = false;
                    ball.grabbed = false;
                    ball.notifyDisturbed();   // resume gravity; restart idle timer
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
                    // Kinematically drag the ball toward the cursor. A snappier
                    // lerp keeps the ball close under a fast swing (less lag =
                    // the throw direction matches the cursor). Z is left alone
                    // so any depth motion carries through the grab.
                    const prevX = ball.position.x;
                    const prevY = ball.position.y;
                    const lerp = Math.min(1, dt * 26);
                    ball.position.x += (mouseWorld.x - ball.position.x) * lerp;
                    ball.position.y += (mouseWorld.y - ball.position.y) * lerp;
                    const invDt = 1 / Math.max(0.001, dt);
                    ball.velocity.x = (ball.position.x - prevX) * invDt;
                    ball.velocity.y = (ball.position.y - prevY) * invDt;
                    // velocity.z untouched — physics carries it
                }
            } else if (mouseEnabled && mouseIsDown && rayDist < grabRadius) {
                mouseGrabbed = true;
                ball.grabbed = true;
                ball.notifyDisturbed();
            } else {
                // Not grabbing this frame — apply the no-grab effects.
                if (mousePush) {
                    // The cursor behaves like a small solid object: when it
                    // overlaps the ball, shove the ball to the cursor's edge
                    // (positional, feels solid) and impart the cursor's motion
                    // so a quick swipe bats it away. No grab required.
                    const dx = ball.position.x - mouseWorld.x;
                    const dy = ball.position.y - mouseWorld.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const pushR = ball.baseRadius * 1.15;
                    if (dist < pushR && dist > 1e-4) {
                        const nx = dx / dist, ny = dy / dist;   // cursor → ball
                        ball.position.x += nx * (pushR - dist);
                        ball.position.y += ny * (pushR - dist);
                        const invDt = 1 / Math.max(0.001, dt);
                        const cvx = THREE.MathUtils.clamp((mouseWorld.x - mouseWorldPrev.x) * invDt, -30, 30);
                        const cvy = THREE.MathUtils.clamp((mouseWorld.y - mouseWorldPrev.y) * invDt, -30, 30);
                        ball.velocity.x = cvx * 0.6 + nx * 2.5;
                        ball.velocity.y = cvy * 0.6 + ny * 2.5;
                        ball.angularVelocity.z += -cvx * 0.04;
                        ball.angularVelocity.x +=  cvy * 0.04;
                        ball.notifyDisturbed();
                    }
                }
                if (mouseFollow) {
                    // Mouse breeze: convert this frame's cursor movement into a
                    // light global impulse, even when the cursor isn't on the ball.
                    const mvx = THREE.MathUtils.clamp(mouseWorld.x - mouseWorldPrev.x, -4, 4);
                    const mvy = THREE.MathUtils.clamp(mouseWorld.y - mouseWorldPrev.y, -4, 4);
                    ball.applyImpulse(mvx * 0.22, mvy * 0.22, 0, 0.008);
                }
            }

            // Track cursor world position for the next frame's deltas.
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
        // ±X/±Y are sampled at the full hair reach (they define the visible
        // silhouette edge). ±Z (toward/away the camera) are sampled at the
        // BODY radius only: hair pointing at the camera is seen end-on and is
        // visually negligible, but with the elevated camera those points
        // project far down/up the screen and used to inflate the vertical
        // margins so much the ball could barely move up or down.
        const _clAxes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        function clampBallToViewport() {
            // Clamp the BODY plus a little hair to the screen, not the full
            // fuzzy reach — otherwise the dense hair nearly fills the frame
            // and the ball can barely travel up/down before tips touch an
            // edge (the vertical "snap back"). Letting the wispy outer hair
            // clip at the extreme edges looks natural and frees the ball to
            // roam corner to corner.
            const clampR = ball.baseRadius + fur._hairLength * 0.15;
            const bodyR = ball.baseRadius;
            _clProj.copy(ball.position).project(camera);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = 0; k < 6; k++) {
                const a = _clAxes[k];
                const rr = (k < 4) ? clampR : bodyR;   // ±Z at body radius
                _clTmp.set(
                    ball.position.x + a[0] * rr,
                    ball.position.y + a[1] * rr,
                    ball.position.z + a[2] * rr
                ).project(camera);
                if (_clTmp.x < minX) minX = _clTmp.x;
                if (_clTmp.x > maxX) maxX = _clTmp.x;
                if (_clTmp.y < minY) minY = _clTmp.y;
                if (_clTmp.y > maxY) maxY = _clTmp.y;
            }
            // Asymmetric extents from center to each silhouette edge (NDC),
            // with a tiny safety pad. Clamp the center so every edge stays
            // inside [-1, 1].
            const S = 1.03;
            const leftE  = (_clProj.x - minX) * S;
            const rightE = (maxX - _clProj.x) * S;
            const downE  = (_clProj.y - minY) * S;
            const upE    = (maxY - _clProj.y) * S;
            // If the silhouette is larger than the screen on an axis (zoomed
            // in / very long hair) there is NO position that fits — skip
            // clamping that axis entirely instead of forcing it to the screen
            // centre. (The old centering read as the ball "snapping back to
            // the middle" whenever you dragged it up or down while zoomed.)
            const clampX = (leftE + rightE) < 2;
            const clampY = (downE + upE) < 2;
            let nx = _clProj.x, ny = _clProj.y, hitX = 0, hitY = 0;
            if (clampX) {
                if (nx - leftE < -1)      { nx = -1 + leftE;  hitX = -1; }
                else if (nx + rightE > 1) { nx =  1 - rightE; hitX =  1; }
            }
            if (clampY) {
                if (ny - downE < -1)      { ny = -1 + downE;  hitY = -1; }
                else if (ny + upE > 1)    { ny =  1 - upE;    hitY =  1; }
            }
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

        // ---- Adaptive quality controller. ----
        // Keeps the wallpaper smooth on any hardware / refresh rate: it
        // measures the real CPU work per rendered frame (sim + render submit)
        // and, if that work won't fit the frame budget, trims the hair count;
        // when there's spare headroom it restores hair up to the user's
        // chosen quality. (State is declared above attach(); this is the
        // per-frame logic.)
        function updateAdaptive(dt) {
            if (!adaptiveEnabled) return;
            adaptAccum += dt;
            if (adaptAccum < 0.5) return;   // re-evaluate ~twice a second
            adaptAccum = 0;
            const budget = 1000 / Math.max(15, limiter.getTargetFps());
            // Reduce if work is eating most of the budget; recover if there's
            // clear headroom. The gap between the thresholds prevents hunting.
            if (workEMA > budget * 0.85 && adaptiveScale > 0.2) {
                adaptiveScale = Math.max(0.2, adaptiveScale - 0.08);
                fur.setAdaptiveScale(adaptiveScale);
            } else if (workEMA < budget * 0.5 && adaptiveScale < 1) {
                adaptiveScale = Math.min(1, adaptiveScale + 0.05);
                fur.setAdaptiveScale(adaptiveScale);
            }
        }

        function frame(now) {
            global.requestAnimationFrame(frame);
            if (docHidden || paused) return;
            if (!limiter.shouldRender(now)) return;

            // Cap dt for stability — a tab-switch can produce a huge gap.
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            elapsed += dt;

            const workStart = performance.now();
            applyMouseToBall(dt);
            applyAudio();
            ball.update(dt, elapsed);
            clampBallToViewport();   // hard on-screen guarantee, before hair reads position
            fur.update(dt, elapsed);
            updateGroundShadow();
            if (bloomEnabled) bloom.render(scene, camera);
            else renderer.render(scene, camera);
            // EMA of the per-frame work time (CPU sim + render submit).
            workEMA += ((performance.now() - workStart) - workEMA) * 0.1;
            updateAdaptive(dt);
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
                        "Work " + workEMA.toFixed(1) + " ms  (budget " + (1000 / tgt).toFixed(1) + ")\n" +
                        "Hairs " + hairs + " × " + fur.getSegments() + " seg  (adapt " +
                            (adaptiveEnabled ? (adaptiveScale * 100).toFixed(0) + "%" : "off") + ")\n" +
                        "Ball pos " + p.x.toFixed(1) + "," + p.y.toFixed(1) + "," + p.z.toFixed(1) + "\n" +
                        "DPR " + (renderer.getPixelRatio()).toFixed(2) + "  " +
                        window.innerWidth + "×" + window.innerHeight;
                }
            }
        }
        global.requestAnimationFrame(frame);

        // Expose for console inspection.
        Marimo.app = {
            scene: scene, camera: camera, renderer: renderer,
            ball: ball, fur: fur, limiter: limiter, bloom: bloom,
            refit: refit,
            isBloomEnabled: function () { return bloomEnabled; }
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window);
