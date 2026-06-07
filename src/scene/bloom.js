/**
 * Bloom — a lightweight, self-contained glow post-process.
 *
 * Wallpaper Engine runs the classic (global `THREE`) build, not ES modules,
 * so we can't use three's example EffectComposer/UnrealBloomPass. This is a
 * minimal hand-rolled equivalent with zero extra dependencies:
 *
 *   1. render the scene normally to the canvas (crisp, correct colours)
 *   2. render the scene again into a low-res target
 *   3. bright-pass: keep only pixels above a luminance threshold
 *   4. separable Gaussian blur (H then V, a couple of iterations)
 *   5. additively overlay the blurred glow back onto the canvas
 *
 * It's toggle-gated and off by default, so the base wallpaper pays nothing
 * unless the user turns it on. The blur targets are half-resolution, so even
 * when enabled it's only a few cheap full-screen passes.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    const VERT = [
        "varying vec2 vUv;",
        "void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }"
    ].join("\n");

    const BRIGHT_FRAG = [
        "uniform sampler2D tDiffuse;",
        "uniform float threshold;",
        "varying vec2 vUv;",
        "void main(){",
        "  vec4 c = texture2D(tDiffuse, vUv);",
        "  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));",
        "  float k = max(0.0, l - threshold) / max(l, 1e-4);",
        "  gl_FragColor = vec4(c.rgb * k, 1.0);",
        "}"
    ].join("\n");

    const BLUR_FRAG = [
        "uniform sampler2D tDiffuse;",
        "uniform vec2 dir;",   // (1,0) horizontal or (0,1) vertical, in texel units
        "varying vec2 vUv;",
        "void main(){",
        "  float w0 = 0.227027, w1 = 0.194595, w2 = 0.121622, w3 = 0.054054, w4 = 0.016216;",
        "  vec3 s = texture2D(tDiffuse, vUv).rgb * w0;",
        "  s += texture2D(tDiffuse, vUv + dir * 1.0).rgb * w1;",
        "  s += texture2D(tDiffuse, vUv - dir * 1.0).rgb * w1;",
        "  s += texture2D(tDiffuse, vUv + dir * 2.0).rgb * w2;",
        "  s += texture2D(tDiffuse, vUv - dir * 2.0).rgb * w2;",
        "  s += texture2D(tDiffuse, vUv + dir * 3.0).rgb * w3;",
        "  s += texture2D(tDiffuse, vUv - dir * 3.0).rgb * w3;",
        "  s += texture2D(tDiffuse, vUv + dir * 4.0).rgb * w4;",
        "  s += texture2D(tDiffuse, vUv - dir * 4.0).rgb * w4;",
        "  gl_FragColor = vec4(s, 1.0);",
        "}"
    ].join("\n");

    class Bloom {
        constructor(renderer) {
            this.renderer = renderer;
            this.strength = 0.8;
            this.threshold = 0.5;
            this.iterations = 2;     // blur H/V passes

            // Full-screen quad rig (ortho cam + 2-unit plane).
            this._quadScene = new THREE.Scene();
            this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
            this._quad.frustumCulled = false;
            this._quadScene.add(this._quad);

            const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
            this._rtScene = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true });
            this._rtA = new THREE.WebGLRenderTarget(2, 2, rtOpts);
            this._rtB = new THREE.WebGLRenderTarget(2, 2, rtOpts);

            this._brightMat = new THREE.ShaderMaterial({
                uniforms: { tDiffuse: { value: null }, threshold: { value: this.threshold } },
                vertexShader: VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false
            });
            this._blurMat = new THREE.ShaderMaterial({
                uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
                vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false
            });
            // Additive overlay of the blurred glow onto the canvas.
            this._overlayMat = new THREE.MeshBasicMaterial({
                map: this._rtA.texture, transparent: true, blending: THREE.AdditiveBlending,
                depthTest: false, depthWrite: false
            });

            this._halfW = 1;
            this._halfH = 1;
        }

        setSize(w, h) {
            this._rtScene.setSize(w, h);
            const hw = Math.max(1, Math.floor(w / 2));
            const hh = Math.max(1, Math.floor(h / 2));
            this._halfW = hw; this._halfH = hh;
            this._rtA.setSize(hw, hh);
            this._rtB.setSize(hw, hh);
        }

        setStrength(s) { this.strength = Math.max(0, s); }
        setThreshold(t) { this.threshold = Math.max(0, Math.min(1, t)); this._brightMat.uniforms.threshold.value = this.threshold; }

        _blit(material, target) {
            this._quad.material = material;
            this.renderer.setRenderTarget(target || null);
            this.renderer.render(this._quadScene, this._quadCam);
        }

        /** Full pipeline: base render + glow overlay, ending on the canvas. */
        render(scene, camera) {
            const r = this.renderer;
            const prevAutoClear = r.autoClear;

            // 1) base image to the canvas (normal, correct colours).
            r.setRenderTarget(null);
            r.autoClear = true;
            r.render(scene, camera);

            // 2) capture the scene into a target for glow extraction.
            r.setRenderTarget(this._rtScene);
            r.clear();
            r.render(scene, camera);

            // 3) bright-pass → half-res rtA.
            this._brightMat.uniforms.tDiffuse.value = this._rtScene.texture;
            this._blit(this._brightMat, this._rtA);

            // 4) separable Gaussian blur, ping-ponging rtA <-> rtB.
            for (let i = 0; i < this.iterations; i++) {
                this._blurMat.uniforms.tDiffuse.value = this._rtA.texture;
                this._blurMat.uniforms.dir.value.set(1 / this._halfW, 0);
                this._blit(this._blurMat, this._rtB);
                this._blurMat.uniforms.tDiffuse.value = this._rtB.texture;
                this._blurMat.uniforms.dir.value.set(0, 1 / this._halfH);
                this._blit(this._blurMat, this._rtA);
            }

            // 5) additive overlay onto the canvas (don't clear the base image).
            this._overlayMat.map = this._rtA.texture;
            this._overlayMat.color.setScalar(this.strength);
            r.autoClear = false;
            this._blit(this._overlayMat, null);

            r.autoClear = prevAutoClear;
            r.setRenderTarget(null);
        }

        dispose() {
            this._rtScene.dispose(); this._rtA.dispose(); this._rtB.dispose();
            this._brightMat.dispose(); this._blurMat.dispose(); this._overlayMat.dispose();
            this._quad.geometry.dispose();
        }
    }

    Marimo.Bloom = Bloom;
})(window);
