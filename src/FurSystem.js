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
        low: 3500,
        medium: 10000,
        high: 20000,
        ultra: 32000
    };

    // We pre-allocate buffers for the largest preset so changing quality at
    // runtime is just a draw-range tweak — no GC, no GPU re-upload.
    const MAX_HAIRS = QUALITY_HAIRS.ultra;

    class FurSystem {
        constructor(scene, ball, opts) {
            opts = opts || {};
            this._ball = ball;
            this._scene = scene;

            // --- Tunables (settable at any time via setters) ---
            this._quality = opts.quality || "medium";
            this._maxForQuality = QUALITY_HAIRS[this._quality];
            this._hairAmount = opts.hairAmount != null ? opts.hairAmount : 1.0; // 0..1
            this._hairLength = opts.hairLength != null ? opts.hairLength : 4.0;
            this._hairVolume = opts.hairVolume != null ? opts.hairVolume : 0.7;  // 0..1
            this._gravity = opts.gravity != null ? opts.gravity : 0.6;
            this._windStrength = opts.windStrength != null ? opts.windStrength : 0.4;
            this._damping = 0.985;

            // Color sampler — replaced via setColorMode.
            this._colorSampler = Marimo.colorModes.getSampler("natural");
            this._colorIsDynamic = false; // set true for rgbNeon
            this._colorMode = "natural";
            this._colorCustomA = null;
            this._colorCustomB = null;
            this._colorDirty = true;

            // --- TypedArray simulation state ---
            this._rootDir = Marimo.fibonacciSphere(MAX_HAIRS); // Float32Array length MAX_HAIRS*3
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
                let s = 0x9E3779B9 ^ 0xDEADBEEF; // fixed seed → identical layout each load
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

            // Scratch.
            this._scratchRoot = new THREE.Vector3();
            this._scratchTmp = new THREE.Vector3();

            // Place all strands at rest (extended radially) so the marimo
            // appears fully puffed up at frame 0 rather than "growing in".
            this._initRestState();
            this._recomputeActiveHairs();
            this._regenerateStaticColors();
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
            this._hairLength = Math.max(0.5, Math.min(8, v));
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
            this._colorIsDynamic = (mode === "rgbNeon");
            this._colorMode = mode;                 // remembered so main can poll
            this._colorCustomA = customA;
            this._colorCustomB = customB;
            this._colorDirty = true;
        }
        getColorMode() { return this._colorMode; }
        /** Re-resolve the sampler — used by the system-accent poller. */
        refreshColorSampler() {
            this._colorSampler = Marimo.colorModes.getSampler(
                this._colorMode, this._colorCustomA, this._colorCustomB);
            this._colorDirty = true;
        }
        setBloomLike(enabled) {
            // Cheap "glow" approximation without a real bloom pass: switch the
            // material to additive blending so overlapping strands brighten.
            this._material.blending = enabled ? THREE.AdditiveBlending : THREE.NormalBlending;
            this._material.transparent = enabled;
            this._material.needsUpdate = true;
        }

        getActiveHairCount() { return this._activeHairs; }
        getSegments() { return SEGMENTS; }

        // ---- Internal helpers ----

        _recomputeActiveHairs() {
            this._activeHairs = Math.max(50, Math.floor(this._maxForQuality * this._hairAmount));
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

        _regenerateStaticColors() {
            // Pre-bake color attribute for non-dynamic color modes. We compute
            // per-vertex (per-segment-endpoint) colors via the sampler and
            // include the "tip diffusion" term that the original adds to hint
            // at directional lighting in the moss mode.
            const sampler = this._colorSampler;
            const time = 0;
            const cb = this._colorBuffer;
            const lightX = -1 / Math.sqrt(21), lightY = -4 / Math.sqrt(21), lightZ = -2 / Math.sqrt(21);
            for (let h = 0; h < this._activeHairs; h++) {
                const rb = h * 3;
                const ny = this._rootDir[rb + 1]; // for "top whorl" boost
                for (let i = 0; i <= SEGMENTS; i++) {
                    let t = i / SEGMENTS;
                    // Tangent direction approximation = root normal (good enough at rest).
                    const tdiff = Math.max(0, Math.abs(
                        this._rootDir[rb + 0] * lightX + this._rootDir[rb + 1] * lightY + this._rootDir[rb + 2] * lightZ));
                    const diffuse = Math.sqrt(Math.max(0.0, 1.0 - tdiff * tdiff));
                    // Top-whorl brightening (the original: pow(max(0, dist*n.y), 4) on tip).
                    const tipBoost = Math.pow(Math.max(0, ny), 4) * (i / SEGMENTS);
                    const tEff = Math.min(1, t + tipBoost * 0.6);
                    const c = sampler(tEff, h, time);
                    const off = (h * POINTS_PER_HAIR + i) * 3;
                    cb[off + 0] = c.r * (0.6 + 0.4 * diffuse);
                    cb[off + 1] = c.g * (0.6 + 0.4 * diffuse);
                    cb[off + 2] = c.b * (0.6 + 0.4 * diffuse);
                }
            }
            this._geom.attributes.color.needsUpdate = true;
        }

        _updateDynamicColors(time) {
            const sampler = this._colorSampler;
            const cb = this._colorBuffer;
            for (let h = 0; h < this._activeHairs; h++) {
                for (let i = 0; i <= SEGMENTS; i++) {
                    const t = i / SEGMENTS;
                    const c = sampler(t, h, time);
                    const off = (h * POINTS_PER_HAIR + i) * 3;
                    cb[off + 0] = c.r;
                    cb[off + 1] = c.g;
                    cb[off + 2] = c.b;
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
            const gAcc = -this._gravity * 0.045 * dt60 * dt60;
            const windAmp = this._windStrength * 0.04 * dt60 * dt60;
            // Per-hair max radius is derived inside the constraint loop using
            // the per-hair length scale, so each strand has its own envelope.
            const volume = this._hairVolume;

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

                // Verlet integrate points 1..SEGMENTS.
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
                    pos[off + 0] = px + vx;
                    pos[off + 1] = py + vy;
                    pos[off + 2] = pz + vz;
                }
            }

            // -------- 2) constraint relaxation (3 passes) --------
            //  (a) distance constraint per segment
            //  (b) volume constraint per point (min radius from ball center)
            //  (c) max-length clamp per point (from root)
            const ITERATIONS = 3;
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
            if (this._colorIsDynamic) {
                this._updateDynamicColors(time);
            } else if (this._colorDirty) {
                this._regenerateStaticColors();
                this._colorDirty = false;
            }
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
