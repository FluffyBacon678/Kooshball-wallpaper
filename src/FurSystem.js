/**
 * FurSystem — procedural verlet hair on a sphere, rendered as LineSegments.
 *
 * Why CPU verlet instead of GPU ping-pong textures (like the original)?
 *   - JS+TypedArrays at our hair counts costs ~2-4 ms/frame on a mid-range CPU.
 *   - Avoids the GPU plumbing (FBOs, render-to-float, ping-pong) that's brittle
 *     in CEF/file:// contexts. This wallpaper has to "just work" on user GPUs.
 *   - The simulation is identical in spirit: verlet integration, distance
 *     constraints, volume constraint (min radius per segment), max-length clamp.
 *
 * Layout:
 *   - rootDir[h*3 + axis]                              unit normal at sphere surface
 *   - pos [h * pointsPerHair * 3 + i*3 + axis]         current point world position
 *   - ppos[h * pointsPerHair * 3 + i*3 + axis]         previous point world position
 *
 * Rendering:
 *   - One BufferGeometry, position attribute = maxHairs * pointsPerHair vertices.
 *   - Index buffer turns each strand into segments LineSegments.
 *   - setDrawRange limits how many strands we actually render this frame.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    // Quality presets — how many hairs and how many segments.
    // Segments is kept constant across presets so the geometry buffer doesn't
    // need to be re-allocated when the user changes quality at runtime.
    // 7 segments matches the original Marimo's HAIR_DIV-1. Smoother curve
    // per strand than 6 with only marginal CPU/GPU cost.
    const SEGMENTS = 7;
    const POINTS_PER_HAIR = SEGMENTS + 1; // root + N tip points

    // Maximum strand counts per quality preset.
    const QUALITY_HAIRS = {
        low: 5000,
        medium: 14000,
        high: 28000,
        ultra: 45000
    };

    // We pre-allocate buffers for the largest preset so changing quality at
    // runtime is just a draw-range tweak — no GC, no GPU re-upload.
    const MAX_HAIRS = QUALITY_HAIRS.ultra;

    class FurSystem {
        constructor(scene, ball, opts) {
            opts = opts || {};
            this._ball = ball;
            this._scene = scene;
            // Per-instance seed so multiple marimos get distinct hair layouts.
            this._seed = (opts.seed | 0) || 0;

            // --- Tunables (settable at any time via setters) ---
            this._quality = opts.quality || "medium";
            this._maxForQuality = QUALITY_HAIRS[this._quality];
            this._adaptiveScale = 1.0; // auto-perf multiplier (FPS controller)
            this._hairAmount = opts.hairAmount != null ? opts.hairAmount : 1.0; // 0..1
            this._hairLength = opts.hairLength != null ? opts.hairLength : 4.0;
            this._hairVolume = opts.hairVolume != null ? opts.hairVolume : 0.7;  // 0..1
            this._gravity = opts.gravity != null ? opts.gravity : 0.6;
            this._windStrength = opts.windStrength != null ? opts.windStrength : 0.4;
            // Per-60fps-frame velocity retention for hair points. Lower =
            // hair sheds motion faster and "relaxes" sooner after the ball
            // stops. (There is no strand-to-strand interaction in this model;
            // the lingering jiggle users notice is just under-damped verlet
            // velocity, so this is the lever that fixes it.) 0.94 settles in
            // ~0.3 s while still flowing nicely while the ball is in motion.
            this._damping = 0.94;

            // Bending stiffness: how strongly each strand returns to its
            // radial "grown" direction each frame. This is what makes the ball
            // ROUND at rest — without it, gravity alone shapes the rest pose
            // into a teardrop (tips sag and pile at the bottom). The rest
            // target moves with the ball, so in motion the hair still flows
            // and lags; only the *resting* shape is pulled back to a sphere.
            this._stiffness = 0.07;

            // Color sampler — replaced via setColorMode.
            this._colorSampler = Marimo.colorModes.getSampler("natural");
            this._colorIsDynamic = false; // true for rgbNeon / rainbow (unlit, per-frame)
            this._colorMode = "natural";
            this._colorCustomA = null;
            this._colorCustomB = null;
            this._colorDirty = true;

            // Extended look controls.
            this._colorCycleSpeed = 0;  // >0 rotates hue over time (per-frame bake)
            this._rgbSpeed = 1;         // animation rate for rgbNeon (and any time-based mode)
            this._brightness = 1;       // master brightness (material multiply)
            this._audioGlow = 0;        // transient brightness from audio (set per-frame)
            this._audioPuff = 0;        // transient hair-volume boost from audio
            this._scratchRGB = [0, 0, 0];

            // --- TypedArray simulation state ---
            this._rootDir = Marimo.fibonacciSphere(MAX_HAIRS); // Float32Array length MAX_HAIRS*3
            // Jitter each root direction slightly (then renormalize). Mirrors
            // the original Marimo's per-vertex perturbation. Critically, it
            // breaks the perfectly-axial strands at the poles: a hair pointing
            // exactly +Y has gravity acting along its own axis and can't bend,
            // so it stands up as a rigid spike. A tiny nudge gives gravity a
            // lever arm and the spike droops into the rest of the fur.
            // Per-hair tangent (unit vector perpendicular to the root dir,
            // random azimuth). Strands curl along this tangent toward their
            // tips so the fur reads as soft swirled fuzz instead of a straight
            // radial "dandelion" burst — while the random per-hair directions
            // average out, keeping the overall ball round.
            this._hairTangent = new Float32Array(MAX_HAIRS * 3);
            {
                let s = (0x1234567 ^ 0x9E3779B9) + this._seed * 0x6D2B79F5 | 0;
                s = s >>> 0; if (s === 0) s = 1;
                const J = 0.03;
                const rnd = function () {
                    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
                    return s / 0xFFFFFFFF;
                };
                for (let h = 0; h < MAX_HAIRS; h++) {
                    const b = h * 3;
                    const jx = (rnd() - 0.5) * 2 * J;
                    const jy = (rnd() - 0.5) * 2 * J;
                    const jz = (rnd() - 0.5) * 2 * J;
                    let x = this._rootDir[b] + jx, y = this._rootDir[b + 1] + jy, z = this._rootDir[b + 2] + jz;
                    let inv = 1 / (Math.hypot(x, y, z) || 1);
                    x *= inv; y *= inv; z *= inv;
                    this._rootDir[b] = x; this._rootDir[b + 1] = y; this._rootDir[b + 2] = z;

                    // Two orthonormal vectors perpendicular to the root dir.
                    // Pick a helper axis not parallel to the normal.
                    let ax = 0, ay = 1, az = 0;
                    if (Math.abs(y) > 0.9) { ax = 1; ay = 0; az = 0; }
                    // t1 = normalize(cross(n, helper))
                    let t1x = y * az - z * ay;
                    let t1y = z * ax - x * az;
                    let t1z = x * ay - y * ax;
                    inv = 1 / (Math.hypot(t1x, t1y, t1z) || 1);
                    t1x *= inv; t1y *= inv; t1z *= inv;
                    // t2 = cross(n, t1)
                    const t2x = y * t1z - z * t1y;
                    const t2y = z * t1x - x * t1z;
                    const t2z = x * t1y - y * t1x;
                    // Random azimuth around the normal.
                    const az2 = rnd() * Math.PI * 2;
                    const ca = Math.cos(az2), sa = Math.sin(az2);
                    this._hairTangent[b]     = t1x * ca + t2x * sa;
                    this._hairTangent[b + 1] = t1y * ca + t2y * sa;
                    this._hairTangent[b + 2] = t1z * ca + t2z * sa;
                }
            }
            // How far the tip curls along its tangent, as a fraction of hair
            // length. 0 = straight radial spikes, higher = softer swirled fuzz.
            this._curl = 0.72;
            this._pos = new Float32Array(MAX_HAIRS * POINTS_PER_HAIR * 3);
            this._ppos = new Float32Array(MAX_HAIRS * POINTS_PER_HAIR * 3);

            // Per-hair length multiplier. The original Marimo's Main.hx
            // jitters each hair *vertex* tangentially at construction so the
            // outer silhouette isn't a perfect deformed sphere — that's what
            // hides the gravity teardrop and makes the marimo read as a
            // round fuzzy ball. We achieve the same fluffy variance with a
            // deterministic per-hair length scale in [0.80, 1.20].
            this._hairLengthScale = new Float32Array(MAX_HAIRS);
            {
                let s = ((0x9E3779B9 ^ 0xDEADBEEF) + this._seed * 0x85EBCA6B) >>> 0;
                if (s === 0) s = 1;
                for (let h = 0; h < MAX_HAIRS; h++) {
                    s ^= s << 13; s >>>= 0;
                    s ^= s >>> 17;
                    s ^= s << 5;  s >>>= 0;
                    this._hairLengthScale[h] = 0.80 + (s / 0xFFFFFFFF) * 0.40;
                }
            }

            // --- Three.js renderable ---
            this._geom = new THREE.BufferGeometry();
            this._positionBuffer = new Float32Array(MAX_HAIRS * POINTS_PER_HAIR * 3);
            this._colorBuffer = new Float32Array(MAX_HAIRS * POINTS_PER_HAIR * 3);
            this._geom.setAttribute("position", new THREE.BufferAttribute(this._positionBuffer, 3).setUsage(THREE.DynamicDrawUsage));
            this._geom.setAttribute("color", new THREE.BufferAttribute(this._colorBuffer, 3).setUsage(THREE.DynamicDrawUsage));

            // Index buffer: for hair h, segments j -> pair (h*PPH+j, h*PPH+j+1).
            // Total indices = MAX_HAIRS * SEGMENTS * 2.
            const idxCount = MAX_HAIRS * SEGMENTS * 2;
            const IndexArrayCtor = idxCount > 65535 ? Uint32Array : Uint16Array;
            const indices = new IndexArrayCtor(idxCount);
            for (let h = 0; h < MAX_HAIRS; h++) {
                const base = h * POINTS_PER_HAIR;
                const oBase = h * SEGMENTS * 2;
                for (let j = 0; j < SEGMENTS; j++) {
                    indices[oBase + j * 2 + 0] = base + j;
                    indices[oBase + j * 2 + 1] = base + j + 1;
                }
            }
            this._geom.setIndex(new THREE.BufferAttribute(indices, 1));

            this._material = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: false,
                fog: false,
                // Slight additive feel via blendMode — disabled by default since
                // LineBasicMaterial doesn't expose blend directly. Toggle in setBloom().
            });

            this._lineSegments = new THREE.LineSegments(this._geom, this._material);
            this._lineSegments.frustumCulled = false; // always visible — we never move it
            scene.add(this._lineSegments);

            // Place all strands at rest (extended radially) so the marimo
            // appears fully puffed up at frame 0 rather than "growing in".
            this._initRestState();
            this._recomputeActiveHairs();
            this._bakeColors(0);
        }

        // ---- Setters (driven by user properties) ----
        setQuality(q) {
            if (!QUALITY_HAIRS[q]) return;
            this._quality = q;
            this._maxForQuality = QUALITY_HAIRS[q];
            this._recomputeActiveHairs();
            this._colorDirty = true;
        }
        setHairAmount(v) {
            this._hairAmount = Math.max(0, Math.min(1, v));
            this._recomputeActiveHairs();
            this._colorDirty = true;
        }
        setHairLength(v) {
            this._hairLength = Math.max(0.5, Math.min(12, v));
            // Re-init rest state so the new length takes immediate visual effect
            // (without this, hair would slowly "grow" via constraint relaxation).
            this._initRestState();
        }
        /** Public alias: callers outside the module should use this. */
        recomputeRestState() { this._initRestState(); }
        setHairVolume(v) { this._hairVolume = Math.max(0.1, Math.min(1.0, v)); }
        setGravity(v) { this._gravity = Math.max(0, Math.min(3, v)); }
        setWindStrength(v) { this._windStrength = Math.max(0, Math.min(3, v)); }
        setColorMode(mode, customA, customB) {
            this._colorSampler = Marimo.colorModes.getSampler(mode, customA, customB);
            this._colorIsDynamic = Marimo.colorModes.isUnlitMode(mode);
            this._colorMode = mode;                 // remembered so main can poll
            this._colorCustomA = customA;
            this._colorCustomB = customB;
            this._colorDirty = true;
        }
        getColorMode() { return this._colorMode; }
        /** Re-resolve the sampler — used by the system-accent / scheme pollers. */
        refreshColorSampler() {
            this._colorSampler = Marimo.colorModes.getSampler(
                this._colorMode, this._colorCustomA, this._colorCustomB);
            this._colorDirty = true;
        }
        setColorCycleSpeed(v) { this._colorCycleSpeed = Math.max(0, Math.min(2, v)); this._colorDirty = true; }
        setRgbSpeed(v) { this._rgbSpeed = Math.max(0, Math.min(4, v)); }
        setBrightness(v) { this._brightness = Math.max(0.1, Math.min(2, v)); }
        setAudioGlow(v) { this._audioGlow = Math.max(0, v); }
        setAudioPuff(v) { this._audioPuff = Math.max(0, v); }
        /** True when colours must be regenerated every frame. */
        _colorNeedsPerFrame() { return this._colorIsDynamic || this._colorCycleSpeed > 0; }
        getActiveHairCount() { return this._activeHairs; }
        getSegments() { return SEGMENTS; }
        // Adaptive performance scale [0.2..1] applied on top of the user's
        // quality + hair-amount, driven by the FPS controller in main.js.
        setAdaptiveScale(v) {
            const s = Math.max(0.2, Math.min(1, v));
            if (Math.abs(s - this._adaptiveScale) < 0.005) return;
            this._adaptiveScale = s;
            this._recomputeActiveHairs();
            this._colorDirty = true;
        }
        getAdaptiveScale() { return this._adaptiveScale; }

        // ---- Internal helpers ----

        _recomputeActiveHairs() {
            this._activeHairs = Math.max(50, Math.floor(
                this._maxForQuality * this._hairAmount * this._adaptiveScale));
            // Update draw range — each strand contributes SEGMENTS*2 indices.
            this._geom.setDrawRange(0, this._activeHairs * SEGMENTS * 2);
        }

        _initRestState() {
            const radius = this._ball.baseRadius;
            for (let h = 0; h < MAX_HAIRS; h++) {
                const rb = h * 3;
                const nx = this._rootDir[rb + 0];
                const ny = this._rootDir[rb + 1];
                const nz = this._rootDir[rb + 2];
                // Per-hair segment length — varied so the silhouette is fuzzy.
                const segLen = (this._hairLength * this._hairLengthScale[h]) / SEGMENTS;
                for (let i = 0; i <= SEGMENTS; i++) {
                    const r = radius + segLen * i;
                    const off = (h * POINTS_PER_HAIR + i) * 3;
                    this._pos[off + 0] = nx * r;
                    this._pos[off + 1] = ny * r;
                    this._pos[off + 2] = nz * r;
                    this._ppos[off + 0] = nx * r;
                    this._ppos[off + 1] = ny * r;
                    this._ppos[off + 2] = nz * r;
                }
            }
        }

        /**
         * Bake per-vertex colours into the colour buffer.
         *  - Unlit modes (rgbNeon/rainbow): raw sampler colour, no lighting.
         *  - Lit modes (gradients): gradient + diffuse + top-whorl brightening.
         *  - Colour-cycle (>0): rotate every colour's hue by time*speed.
         * Called once for static modes, or every frame when _colorNeedsPerFrame.
         */
        _bakeColors(time) {
            const sampler = this._colorSampler;
            const cb = this._colorBuffer;
            const unlit = this._colorIsDynamic;
            const cycle = this._colorCycleSpeed;
            const out = this._scratchRGB;
            const rot = cycle > 0
                ? Marimo.colorModes.makeHueRotator(time * cycle * Math.PI * 2)
                : null;
            // rgbNeon animates with the sampler's time arg; scale it by the
            // RGB-speed control (computed AFTER the hue-cycle rotator so the
            // two speeds stay independent). Gradient/rainbow samplers ignore
            // the time arg, so this is a no-op for them.
            const stime = time * this._rgbSpeed;
            const lightX = -1 / Math.sqrt(21), lightY = -4 / Math.sqrt(21), lightZ = -2 / Math.sqrt(21);
            const N = this._activeHairs;
            for (let h = 0; h < N; h++) {
                const rb = h * 3;
                const ny = this._rootDir[rb + 1];
                // Lighting terms are per-strand (depend on root dir only).
                let diffuse = 1;
                if (!unlit) {
                    const tdiff = Math.max(0, Math.abs(
                        this._rootDir[rb] * lightX + this._rootDir[rb + 1] * lightY + this._rootDir[rb + 2] * lightZ));
                    diffuse = Math.sqrt(Math.max(0, 1 - tdiff * tdiff));
                }
                for (let i = 0; i <= SEGMENTS; i++) {
                    const t = i / SEGMENTS;
                    let r, g, b;
                    if (unlit) {
                        const c = sampler(t, h, stime);
                        r = c.r; g = c.g; b = c.b;
                    } else {
                        const tipBoost = Math.pow(Math.max(0, ny), 4) * t;
                        const c = sampler(Math.min(1, t + tipBoost * 0.6), h, stime);
                        const k = 0.6 + 0.4 * diffuse;
                        r = c.r * k; g = c.g * k; b = c.b * k;
                    }
                    if (rot) { rot(out, r, g, b); r = out[0]; g = out[1]; b = out[2]; }
                    const off = (h * POINTS_PER_HAIR + i) * 3;
                    cb[off + 0] = r;
                    cb[off + 1] = g;
                    cb[off + 2] = b;
                }
            }
            this._geom.attributes.color.needsUpdate = true;
        }

        /**
         * Run one simulation+render step.
         * @param {number} dt    seconds since last frame
         * @param {number} time  elapsed seconds
         */
        update(dt, time) {
            const N = this._activeHairs;
            const radius = this._ball.radius;
            const baseHairLen = this._hairLength;
            const hairScale = this._hairLengthScale;   // per-hair length multiplier
            // Cap dt tightly — verlet's `accel * dt^2` term spikes hard at
            // big timesteps, which is what users perceive as the marimo
            // "kicking" after a frame hitch. 1/40 s is the floor we promise
            // the sim; below that the animation slows but never blows up.
            const dtCapped = Math.min(0.025, dt);
            const dt60 = dtCapped * 60.0;
            // Damping per second (exponential) → per-step factor. With base
            // 0.985 (per-60fps-frame) we keep visual feel identical at 60fps
            // but stay stable at variable rates.
            const damping = Math.pow(this._damping, dt60);
            // Hair-tip gravity. Scale matches the original Marimo's per-frame
            // ~0.05 acceleration when the user's slider is ~1.0, so dialing
            // gravity up produces *visible* droop quickly.
            const gAcc = -this._gravity * 0.04 * dt60 * dt60;
            const windAmp = this._windStrength * 0.04 * dt60 * dt60;
            // Per-frame stiffness factor (framerate-independent).
            const stiff = 1 - Math.pow(1 - this._stiffness, dt60);
            // Per-hair max radius is derived inside the constraint loop using
            // the per-hair length scale, so each strand has its own envelope.
            // Audio "puff" temporarily inflates the hair-volume envelope so
            // the fur stands out on beats.
            const volume = Math.min(1.4, this._hairVolume + this._audioPuff);
            const baseHairLen2 = this._hairLength;
            const hairScale2 = this._hairLengthScale;
            const hairTangent = this._hairTangent;
            const curl = this._curl;

            const rot = this._ball.getRotationMatrix().elements;
            // Apply rotation to a vector (x,y,z) -> world. THREE matrices are column-major
            // and rot is a Matrix4 with no translation here.
            // rot[0]=m00 rot[4]=m01 rot[8]=m02
            // rot[1]=m10 rot[5]=m11 rot[9]=m12
            // rot[2]=m20 rot[6]=m21 rot[10]=m22

            const bx = this._ball.position.x;
            const by = this._ball.position.y;
            const bz = this._ball.position.z;

            const pos = this._pos;
            const ppos = this._ppos;
            const rootDir = this._rootDir;

            // -------- 1) integration (verlet) + anchor roots --------
            for (let h = 0; h < N; h++) {
                const rb = h * 3;
                const nx0 = rootDir[rb + 0];
                const ny0 = rootDir[rb + 1];
                const nz0 = rootDir[rb + 2];

                // Rotated root direction.
                const rnx = rot[0] * nx0 + rot[4] * ny0 + rot[8] * nz0;
                const rny = rot[1] * nx0 + rot[5] * ny0 + rot[9] * nz0;
                const rnz = rot[2] * nx0 + rot[6] * ny0 + rot[10] * nz0;

                // Rotated per-hair tangent (for curl).
                const tx0 = hairTangent[rb], ty0 = hairTangent[rb + 1], tz0 = hairTangent[rb + 2];
                const rtx = rot[0] * tx0 + rot[4] * ty0 + rot[8] * tz0;
                const rty = rot[1] * tx0 + rot[5] * ty0 + rot[9] * tz0;
                const rtz = rot[2] * tx0 + rot[6] * ty0 + rot[10] * tz0;

                // Wind sampled once per strand using root direction & time.
                const w = Marimo.windAt(nx0, ny0, nz0, time);

                // Anchor root.
                const rootOff = h * POINTS_PER_HAIR * 3;
                pos[rootOff + 0] = bx + rnx * radius;
                pos[rootOff + 1] = by + rny * radius;
                pos[rootOff + 2] = bz + rnz * radius;
                ppos[rootOff + 0] = pos[rootOff + 0];
                ppos[rootOff + 1] = pos[rootOff + 1];
                ppos[rootOff + 2] = pos[rootOff + 2];

                // Per-hair segment length for the radial rest target.
                const segLenH = (baseHairLen2 * hairScale2[h]) / SEGMENTS;

                // Verlet integrate points 1..SEGMENTS, then pull toward the
                // radial rest position (bending stiffness → round at rest).
                for (let i = 1; i <= SEGMENTS; i++) {
                    const off = rootOff + i * 3;
                    const px = pos[off + 0];
                    const py = pos[off + 1];
                    const pz = pos[off + 2];
                    const vx = (px - ppos[off + 0]) * damping + w.x * windAmp;
                    const vy = (py - ppos[off + 1]) * damping + gAcc + w.y * windAmp;
                    const vz = (pz - ppos[off + 2]) * damping + w.z * windAmp;
                    ppos[off + 0] = px;
                    ppos[off + 1] = py;
                    ppos[off + 2] = pz;
                    let npx = px + vx;
                    let npy = py + vy;
                    let npz = pz + vz;
                    // Radial rest target (moves with the ball's centre + spin),
                    // plus a tangential curl that grows toward the tip so the
                    // strand sweeps sideways instead of standing straight out.
                    const tNorm = i / SEGMENTS;
                    const restR = radius + segLenH * i;
                    const curlMag = curl * tNorm * tNorm * segLenH * SEGMENTS;
                    const restX = bx + rnx * restR + rtx * curlMag;
                    const restY = by + rny * restR + rty * curlMag;
                    const restZ = bz + rnz * restR + rtz * curlMag;
                    npx += (restX - npx) * stiff;
                    npy += (restY - npy) * stiff;
                    npz += (restZ - npz) * stiff;
                    pos[off + 0] = npx;
                    pos[off + 1] = npy;
                    pos[off + 2] = npz;
                }
            }

            // -------- 2) constraint relaxation (2 passes) --------
            //  (a) distance constraint per segment
            //  (b) volume constraint per point (min radius from ball center)
            //  (c) max-length clamp per point (from root)
            // 2 passes (down from 3): the per-frame bending stiffness now
            // pulls strands toward their rest shape every step, so the
            // constraints need fewer relaxation passes to stay stable. Saves
            // ~1/3 of the per-frame constraint cost, which matters at the
            // higher hair densities.
            const ITERATIONS = 2;
            for (let it = 0; it < ITERATIONS; it++) {
                for (let h = 0; h < N; h++) {
                    const rootOff = h * POINTS_PER_HAIR * 3;
                    const rootX = pos[rootOff + 0];
                    const rootY = pos[rootOff + 1];
                    const rootZ = pos[rootOff + 2];

                    // Per-hair geometry — different segment length and
                    // envelope per strand for a fuzzy silhouette.
                    const hairLenH = baseHairLen * hairScale[h];
                    const segLen = hairLenH / SEGMENTS;
                    const maxRadius = radius + hairLenH * volume;

                    // (a) distance constraint: walk outward from root.
                    let prevX = rootX, prevY = rootY, prevZ = rootZ;
                    for (let i = 1; i <= SEGMENTS; i++) {
                        const off = rootOff + i * 3;
                        let cx = pos[off + 0];
                        let cy = pos[off + 1];
                        let cz = pos[off + 2];
                        const dx = cx - prevX;
                        const dy = cy - prevY;
                        const dz = cz - prevZ;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        const d = d2 > 1e-12 ? Math.sqrt(d2) : 1e-6;
                        const err = (d - segLen) / d;
                        // Only the outer point moves — root is heavier (fixed).
                        cx -= dx * err;
                        cy -= dy * err;
                        cz -= dz * err;

                        // (b) volume constraint — push the point outside a
                        // per-segment minimum radius envelope. Uniform 0.85
                        // multiplier matches the original Marimo's
                        // `mix(radius, maxRadius, t)` formula and gives a
                        // round silhouette. To get more visible droop the
                        // user should lower the "Hair volume" slider in
                        // Wallpaper Engine — that shrinks maxRadius itself,
                        // letting tips fall further toward the body.
                        const tSeg = i / SEGMENTS;
                        const minR = radius + (maxRadius - radius) * tSeg * 0.85;
                        const ex = cx - bx;
                        const ey = cy - by;
                        const ez = cz - bz;
                        const e2 = ex * ex + ey * ey + ez * ez;
                        if (e2 < minR * minR) {
                            const e = e2 > 1e-12 ? Math.sqrt(e2) : 1e-6;
                            const s = minR / e;
                            cx = bx + ex * s;
                            cy = by + ey * s;
                            cz = bz + ez * s;
                        }

                        // (c) max-length clamp from the strand's root.
                        const maxLen = i * segLen * 1.05;
                        const lx = cx - rootX;
                        const ly = cy - rootY;
                        const lz = cz - rootZ;
                        const l2 = lx * lx + ly * ly + lz * lz;
                        if (l2 > maxLen * maxLen) {
                            const l = Math.sqrt(l2);
                            const s = maxLen / l;
                            cx = rootX + lx * s;
                            cy = rootY + ly * s;
                            cz = rootZ + lz * s;
                        }

                        pos[off + 0] = cx;
                        pos[off + 1] = cy;
                        pos[off + 2] = cz;
                        prevX = cx; prevY = cy; prevZ = cz;
                    }
                }
            }

            // -------- 3) push positions to the render buffer --------
            // Since position layout matches our sim layout 1:1 (h*PPH+i),
            // we can just copy the active prefix. We let Three.js upload the
            // whole buffer — the inactive tail is harmless (drawRange culls it)
            // and r160+ made `updateRange` read-only, so we don't try to
            // narrow it. The cost difference is negligible at our buffer size.
            const writeCount = N * POINTS_PER_HAIR * 3;
            this._positionBuffer.set(pos.subarray(0, writeCount));
            this._geom.attributes.position.needsUpdate = true;

            // -------- 4) color update --------
            if (this._colorNeedsPerFrame()) {
                this._bakeColors(time);
            } else if (this._colorDirty) {
                this._bakeColors(0);
                this._colorDirty = false;
            }

            // -------- 5) brightness + audio glow (cheap material multiply) --------
            // material.color multiplies all vertex colours, so this brightens
            // the whole marimo without touching the per-vertex buffer.
            const bright = this._brightness * (1 + this._audioGlow);
            this._material.color.setScalar(bright);
        }

        dispose() {
            this._scene.remove(this._lineSegments);
            this._geom.dispose();
            this._material.dispose();
        }
    }

    Marimo.FurSystem = FurSystem;
    Marimo.FUR_QUALITY_HAIRS = QUALITY_HAIRS;
})(window);
