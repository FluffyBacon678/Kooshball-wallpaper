/**
 * MarimoBall — rigid-body sphere with linear + angular dynamics.
 *
 * Modeled after saharan's original Marimo.hx (pos/vel/avel) plus the
 * gravity/restitution/wall handling that Main.hx layered on top. Unlike the
 * original we don't share screen with HTML controls, so the ball lives inside
 * an invisible bounded box scaled to the camera's horizontal frustum.
 *
 * Defaults are intentionally calm:
 *   - no auto-spin (users can dial up "Rotation speed" if they want one)
 *   - low gravity, low restitution → ball settles quickly at the floor
 *   - mouse motion applies a soft velocity impulse so the marimo can be
 *     "nudged" around without click+drag (clicks belong to the desktop)
 *
 * The FurSystem reads `position`, `radius` and `rotationMatrix` each frame;
 * everything else is private to this class.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    class MarimoBall {
        constructor(scene, opts) {
            opts = opts || {};
            this.baseRadius = opts.radius || 5;
            this.radius = this.baseRadius;

            // --- Rigid-body state ---
            this.position = new THREE.Vector3(0, 0, 0);
            this.velocity = new THREE.Vector3(0, 0, 0);
            this.angularVelocity = new THREE.Vector3(0, 0, 0);
            this.quaternion = new THREE.Quaternion();
            this.rotationMatrix = new THREE.Matrix4();

            // --- Tunables (settable at runtime via setters) ---
            this.physicsEnabled = true;
            this.gravity = 9.0;            // world-units / s^2
            this.restitution = 0.6;        // floor + walls bounce
            this.linearDamping = 0.35;     // per-second exp damping on velocity — low so throws carry
            this.angularDamping = 0.5;     // per-second exp damping on angular velocity — spins linger

            // When `true` the mouse is dragging the ball: main.js drives
            // position + velocity directly, physics is skipped this frame.
            this.grabbed = false;

            // "DVD bounce" mode: the ball ignores gravity and drifts at a
            // constant speed, bouncing off the screen edges like the old DVD
            // screensaver logo. Speed is in world-units/second.
            this.dvdMode = false;
            this.dvdSpeed = 6;

            // Idle drift: gentle free-floating wander when left untouched.
            this.idleDrift = true;
            this.idleDriftSpeed = 2.5;   // world-units/s of wander
            this._idleT = 0;             // seconds since last disturbance
            this._driftPh = [
                Math.random() * 6.28, Math.random() * 6.28,
                Math.random() * 6.28, Math.random() * 6.28
            ];

            // The bounding box. floorY/ceilingY are the y of the floor/ceiling
            // planes; wallX/wallZ are the |x|/|z| bounds. These are recomputed
            // by setBounds() from the camera fit so the ball never escapes
            // the visible frame in any direction.
            this.floorY = -7;
            this.ceilingY = 7;
            this.wallX = 9;
            // Asymmetric depth bounds. +Z is toward the camera (ball grows on
            // screen → must stay tiny to guarantee it fits). -Z is away from
            // the camera (ball shrinks → free to recede far, which is the "let
            // it fall far back" behaviour). Set properly in setBounds().
            this.wallZNear = 1;    // toward camera (+Z) — very tight
            this.wallZFar  = 18;   // away from camera (-Z) — generous

            // Optional constant spin — off by default. Slider in Wallpaper
            // Engine ("Rotation speed") drives this for users who want
            // continuous motion.
            this._autoSpinAxis = new THREE.Vector3(0.15, 1.0, 0.05).normalize();
            this._autoSpinSpeed = 0;

            // Very subtle breathing — 0.5% amplitude. Reduced from 1.8% so
            // the strand-tip distance constraints don't visibly pulse at
            // the top/bottom of the marimo, while still keeping the
            // simulation alive enough to avoid a frozen lattice.
            this._breathPhase = Math.random() * Math.PI * 2;
            this._breathAmp = 0.005;

            // Transient scale pulse driven by audio (set per-frame by main).
            this._audioScale = 0;

            // --- Body mesh ---
            this._geom = new THREE.SphereGeometry(this.baseRadius * 0.98, 48, 32);
            this._mat = new THREE.MeshStandardMaterial({
                color: 0x0a160a, roughness: 1.0, metalness: 0.0
            });
            this.mesh = new THREE.Mesh(this._geom, this._mat);
            scene.add(this.mesh);

            // Scratch — avoid per-frame allocation.
            this._dq = new THREE.Quaternion();
            this._scratchAxis = new THREE.Vector3();
        }

        // ---- Configuration setters ----

        setBaseRadius(r) {
            this.baseRadius = r;
            this._geom.dispose();
            this._geom = new THREE.SphereGeometry(r * 0.98, 48, 32);
            this.mesh.geometry = this._geom;
        }
        setBodyColor(rgb) {
            const d = 0.18;
            this._mat.color.setRGB(rgb.r * d, rgb.g * d, rgb.b * d);
        }

        setPhysicsEnabled(v) {
            this.physicsEnabled = !!v;
            if (!this.physicsEnabled) {
                this.velocity.set(0, 0, 0);
                this.angularVelocity.set(0, 0, 0);
                this.position.set(0, 0, 0);
            }
        }
        setGravity(v) { this.gravity = Math.max(0, v); }
        setRestitution(v) { this.restitution = Math.max(0, Math.min(0.95, v)); }
        setAutoSpinSpeed(v) { this._autoSpinSpeed = v; }
        setDvdSpeed(v) { this.dvdSpeed = Math.max(0.5, Math.min(30, v)); }
        setIdleDrift(v) { this.idleDrift = !!v; }
        setIdleDriftSpeed(v) { this.idleDriftSpeed = Math.max(0, Math.min(8, v)); }
        /** Reset the idle timer — called whenever the ball is interacted with. */
        notifyDisturbed() { this._idleT = 0; }
        setAudioScale(v) { this._audioScale = v; }
        setDvdMode(v) {
            this.dvdMode = !!v;
            if (this.dvdMode) {
                // Seed a diagonal drift on the z=0 plane and centre the ball
                // vertically so it bounces across the whole screen.
                this.position.z = 0;
                this.velocity.set(0.8, 0.6, 0).normalize().multiplyScalar(this.dvdSpeed);
            }
        }

        /**
         * Recompute the invisible bounding box from a target horizontal extent
         * (world units that should fit on screen). Called from main.js whenever
         * the camera refits — so ball stays in view on any aspect ratio.
         */
        setBounds(visibleHalfWidth, visibleHalfHeight) {
            // Reject NaN / 0 / negative inputs — they happen briefly during
            // page boot when the headless browser hasn't sized the window
            // yet. Keep the constructor defaults until we get real numbers.
            if (!Number.isFinite(visibleHalfWidth) || !Number.isFinite(visibleHalfHeight) ||
                visibleHalfWidth <= 0 || visibleHalfHeight <= 0) {
                return;
            }
            // Leave headroom equal to the ball radius so the silhouette stays
            // inside the frame even when the ball is at maximum displacement.
            this.wallX = Math.max(this.baseRadius + 1, visibleHalfWidth - this.baseRadius);
            // Toward-camera (+Z): keep it tiny so the ball never grows big
            // enough to overflow the frame. Away-from-camera (-Z): generous,
            // so the ball can recede far into the scene (it only shrinks, so
            // it can't go off-screen). Scales with visible width on ultrawide.
            this.wallZNear = this.baseRadius * 0.2;
            this.wallZFar  = Math.max(this.baseRadius * 3, visibleHalfWidth * 1.4);
            const vHalf = Math.max(this.baseRadius + 1, visibleHalfHeight - this.baseRadius);
            this.floorY = -vHalf;
            this.ceilingY =  vHalf;
        }

        /**
         * Apply a velocity impulse and a coupled angular kick.
         * Used by main.js to convert mouse motion into ball motion.
         */
        applyImpulse(vx, vy, vz, spinFactor) {
            if (!this.physicsEnabled) return;
            // Any push counts as a disturbance → restore gravity, pause idle.
            this._idleT = 0;
            this.velocity.x += vx;
            this.velocity.y += vy;
            this.velocity.z += vz;
            if (spinFactor !== 0 && spinFactor !== undefined) {
                // Angular velocity perpendicular-ish to the push so the ball
                // looks like it's rolling, not sliding.
                this.angularVelocity.x +=  vz * spinFactor;
                this.angularVelocity.y += (vx * 0.3 + vz * 0.3) * spinFactor;
                this.angularVelocity.z += -vx * spinFactor;
            }
        }

        // ---- Per-frame update ----

        update(dt, time) {
            // Cap dt so a frame hitch (alt-tab, GPU stall) can't catapult the
            // ball across the screen on its next integration step.
            dt = Math.min(0.033, dt);

            // DVD-bounce mode: constant-speed 2D drift, no gravity. The
            // actual edge bounces are done by the viewport clamp in main.js
            // (it reflects velocity); here we just integrate and keep the
            // speed constant so it never slows down or speeds up.
            if (this.dvdMode && !this.grabbed) {
                this.position.x += this.velocity.x * dt;
                this.position.y += this.velocity.y * dt;
                this.position.z = 0;
                this.velocity.z = 0;
                const sp = Math.hypot(this.velocity.x, this.velocity.y);
                if (sp > 1e-4) {
                    const k = this.dvdSpeed / sp;
                    this.velocity.x *= k;
                    this.velocity.y *= k;
                }
            } else if (this.physicsEnabled && !this.grabbed) {
                // Idle drift: once the ball has been left alone for a moment,
                // gravity gently fades out and the ball free-floats, wandering
                // the screen on smooth noise so it never looks frozen. Any
                // interaction (grab/throw/scroll/audio) resets the timer via
                // notifyDisturbed(), restoring full gravity for a satisfying
                // fall + bounce. It never pulls back to centre — it's free.
                this._idleT += dt;
                let idleF = 0;
                if (this.idleDrift && this.idleDriftSpeed > 0) {
                    idleF = Math.max(0, Math.min(1, (this._idleT - 1.5) / 2.5));
                }

                // Gravity (faded out as idle drift engages).
                this.velocity.y -= this.gravity * dt * (1 - idleF);

                // Exponential damping — framerate-independent. Eased back
                // during idle so the wander velocity isn't immediately bled
                // away (otherwise it just hovers near the floor).
                const linDamp = Math.exp(-this.linearDamping * (1 - idleF * 0.85) * dt);
                this.velocity.multiplyScalar(linDamp);
                const angDamp = Math.exp(-this.angularDamping * dt);
                this.angularVelocity.multiplyScalar(angDamp);

                // Wander toward a slowly-roaming target velocity from smooth
                // noise, so the ball freely meanders the whole frame.
                if (idleF > 0) {
                    const p = this._driftPh;
                    const wx = Math.sin(time * 0.13 + p[0]) + 0.5 * Math.sin(time * 0.31 + p[1]);
                    const wy = Math.sin(time * 0.11 + p[2]) + 0.5 * Math.sin(time * 0.27 + p[3]);
                    const sp = this.idleDriftSpeed * idleF;
                    const tvx = wx * 0.8 * sp;
                    const tvy = wy * 0.6 * sp;
                    const ease = Math.min(1, dt * 1.6);
                    this.velocity.x += (tvx - this.velocity.x) * ease;
                    this.velocity.y += (tvy - this.velocity.y) * ease;
                }

                // Integrate position.
                this.position.x += this.velocity.x * dt;
                this.position.y += this.velocity.y * dt;
                this.position.z += this.velocity.z * dt;

                // Ceiling collision — keeps the ball inside the visible frame
                // when thrown straight up.
                const maxY = this.ceilingY - this.baseRadius;
                if (this.position.y > maxY) {
                    this.position.y = maxY;
                    if (this.velocity.y > 0) this.velocity.y *= -this.restitution;
                    // A ceiling tap also bleeds a little spin energy.
                    this.angularVelocity.multiplyScalar(0.92);
                }

                // Floor collision.
                const minY = this.floorY + this.baseRadius;
                if (this.position.y < minY) {
                    this.position.y = minY;
                    if (this.velocity.y < 0) this.velocity.y *= -this.restitution;
                    // Rolling friction. The angular velocity at the contact
                    // patch becomes lateral linear velocity — ω_z makes the
                    // ball roll along X, ω_x makes it roll along Z. This is
                    // what gives a thrown spinning ball motion in 3D rather
                    // than just sliding flat. We bleed a chunk of angular
                    // energy in the same step.
                    const roll = 0.18;
                    this.velocity.x +=  this.angularVelocity.z * this.baseRadius * roll;
                    this.velocity.z += -this.angularVelocity.x * this.baseRadius * roll;
                    this.angularVelocity.x *= (1 - roll);
                    this.angularVelocity.z *= (1 - roll);
                    // Mild kinetic friction on the lateral velocity itself.
                    this.velocity.x *= 0.94;
                    this.velocity.z *= 0.94;
                    if (Math.abs(this.velocity.y) < 0.3) this.velocity.y = 0;
                    // Y-axis spin loses a little energy too.
                    this.angularVelocity.y *= 0.9;
                }

                // Side walls (X).
                const wxR = this.wallX;
                if (this.position.x > wxR) {
                    this.position.x = wxR;
                    if (this.velocity.x > 0) this.velocity.x *= -this.restitution;
                } else if (this.position.x < -wxR) {
                    this.position.x = -wxR;
                    if (this.velocity.x < 0) this.velocity.x *= -this.restitution;
                }

                // Depth walls (Z), asymmetric: tight toward the camera (+Z),
                // generous away from it (-Z).
                if (this.position.z > this.wallZNear) {
                    this.position.z = this.wallZNear;
                    if (this.velocity.z > 0) this.velocity.z *= -this.restitution;
                } else if (this.position.z < -this.wallZFar) {
                    this.position.z = -this.wallZFar;
                    if (this.velocity.z < 0) this.velocity.z *= -this.restitution;
                }
            }

            // Auto-spin (slider-driven — default 0 means "no auto rotation").
            if (this._autoSpinSpeed > 1e-5) {
                this._dq.setFromAxisAngle(this._autoSpinAxis, this._autoSpinSpeed * dt);
                this.quaternion.premultiply(this._dq);
            }

            // Clamp angular velocity to a sane maximum. Repeated throws,
            // rolling friction and audio spin can otherwise accumulate into a
            // runaway spin on one axis (the "suddenly spinning very fast"
            // bug). MAX_ANGULAR ≈ 0.8 rev/s keeps it lively but controlled.
            const MAX_ANGULAR = 5.0;
            let angLen = this.angularVelocity.length();
            if (angLen > MAX_ANGULAR) {
                this.angularVelocity.multiplyScalar(MAX_ANGULAR / angLen);
                angLen = MAX_ANGULAR;
            }

            // Angular velocity → quaternion integration (rigid-body spin).
            if (angLen > 1e-5) {
                this._scratchAxis.copy(this.angularVelocity).divideScalar(angLen);
                this._dq.setFromAxisAngle(this._scratchAxis, angLen * dt);
                this.quaternion.premultiply(this._dq);
            }

            // Breathing (radius pulsation, ~1.8% amplitude).
            const breath = Math.sin(time * 0.6 + this._breathPhase) * this._breathAmp + 1.0
                + this._audioScale;
            this.radius = this.baseRadius * breath;
            this.mesh.scale.setScalar(breath);

            // Push state to the mesh.
            this.mesh.position.copy(this.position);
            this.mesh.quaternion.copy(this.quaternion);

            // Keep the rotation matrix in sync for the FurSystem.
            this.rotationMatrix.makeRotationFromQuaternion(this.quaternion);
        }

        getRotationMatrix() { return this.rotationMatrix; }

        dispose() {
            this._geom.dispose();
            this._mat.dispose();
        }
    }

    Marimo.MarimoBall = MarimoBall;
})(window);
