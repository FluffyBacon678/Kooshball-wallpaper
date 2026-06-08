/**
 * Wallpaper Engine property bridge.
 *
 * The bootstrap in index.html registers `window.wallpaperPropertyListener`
 * very early and buffers any properties that arrive before the app is ready.
 * This module installs the *real* handlers (window.__marimoApplyUser__ etc.),
 * then replays whatever the bootstrap captured.
 *
 * Every property is optional. We only act on the keys actually present in
 * the incoming object — Wallpaper Engine sends *changed* values, not the
 * full set, after the initial dispatch.
 *
 * In a normal browser (no Wallpaper Engine) this module is harmless: the
 * bootstrap object exists but nothing calls it, and defaults already set
 * inside FurSystem / MarimoBall stand.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    /**
     * @param {object} ctx  { ball, fur, scene, renderer, limiter, camera, refit, ... }
     */
    function attach(ctx) {
        const ball = ctx.ball;
        const fur = ctx.fur;
        const scene = ctx.scene;
        const renderer = ctx.renderer;
        const limiter = ctx.limiter;
        const refit = ctx.refit;
        const setMouseEnabled = ctx.setMouseEnabled;
        const setDebugVisible = ctx.setDebugVisible;

        // We track the currently chosen color mode + custom colors so any
        // one of them changing can re-resolve the sampler.
        const colorState = {
            mode: "natural",
            rgbMode: false,
            customA: null,
            customB: null
        };

        // Changing a custom color picker should auto-switch Color mode to
        // "custom" so the picker visibly does something (otherwise it has no
        // effect unless the mode is already custom — the source of the
        // "custom palette does nothing" confusion).
        //
        // We must NOT do this during the initial property load, or a saved
        // non-custom colorMode would be overridden. Reliable signal: Wallpaper
        // Engine includes EVERY property (incl. colorMode) in the first burst,
        // but sends only the *changed* property afterwards. So we auto-switch
        // only when a custom color arrives (a) after the first batch and
        // (b) in a batch that does not also carry colorMode (i.e. the user
        // dragged the picker, they didn't touch the mode dropdown).
        let firstBatchDone = false;

        function reapplyColors() {
            const effectiveMode = colorState.rgbMode ? "rgbNeon" : colorState.mode;
            fur.setColorMode(effectiveMode, colorState.customA, colorState.customB);
        }

        function value(p) {
            // Wallpaper Engine wraps each prop in { value: ... }; tolerate raw too.
            if (p && typeof p === "object" && "value" in p) return p.value;
            return p;
        }

        // The "Gravity" slider drives BOTH the ball's rigid-body gravity AND
        // the hair-tip droop — that's how the original Marimo works (single
        // gravity scalar affecting the whole system). Internally the ball
        // uses world-units/s², the fur uses a small per-frame coefficient.
        function setUnifiedGravity(g) {
            const v = Math.max(0, g);
            ball.setGravity(v * 15);    // 0..2.5 slider → 0..37.5 m/s² ball gravity
            fur.setGravity(v);          // 0..2.5 slider → hair gravity coefficient
        }

        function applyUser(props) {
            if (!props) return;

            // Did this batch include an explicit color-mode choice? If so the
            // user (or initial load) is driving the mode; a custom color in the
            // same batch must not override it.
            const batchHasColorMode = (props.colorMode !== undefined);

            if (props.quality) {
                fur.setQuality(String(value(props.quality)).toLowerCase());
            }
            if (props.ballSize) {
                const v = Number(value(props.ballSize));
                if (Number.isFinite(v)) {
                    ball.setBaseRadius(v);
                    fur.recomputeRestState();
                    if (ctx.rebuildGround) ctx.rebuildGround();
                    refit();
                    // Move the ball above the new floor so it doesn't snap
                    // through it on the next frame.
                    if (ball.position.y < ball.floorY + ball.baseRadius) {
                        ball.position.y = ball.floorY + ball.baseRadius;
                    }
                }
            }
            if (props.hairAmount) {
                fur.setHairAmount(Number(value(props.hairAmount)));
            }
            if (props.hairLength) {
                fur.setHairLength(Number(value(props.hairLength)));
                refit();
            }
            if (props.hairVolume) {
                fur.setHairVolume(Number(value(props.hairVolume)));
            }
            if (props.gravity) {
                setUnifiedGravity(Number(value(props.gravity)));
            }
            if (props.rotationSpeed !== undefined) {
                ball.setAutoSpinSpeed(Number(value(props.rotationSpeed)));
            }
            if (props.windStrength) {
                fur.setWindStrength(Number(value(props.windStrength)));
            }
            if (props.ballPhysics !== undefined) {
                ball.setPhysicsEnabled(Boolean(value(props.ballPhysics)));
            }
            if (props.bounce) {
                ball.setRestitution(Number(value(props.bounce)));
            }

            if (props.rgbMode) {
                colorState.rgbMode = Boolean(value(props.rgbMode));
                reapplyColors();
            }
            if (props.colorMode) {
                colorState.mode = String(value(props.colorMode));
                reapplyColors();
            }
            // A live drag of a custom color picker (after load, in a batch
            // without an explicit colorMode) implies the user wants custom.
            const autoCustom = firstBatchDone && !batchHasColorMode && !colorState.rgbMode;
            if (props.customColor1) {
                colorState.customA = Marimo.colorModes.parseColor(value(props.customColor1), null);
                if (autoCustom) colorState.mode = "custom";
                reapplyColors();
            }
            if (props.customColor2) {
                colorState.customB = Marimo.colorModes.parseColor(value(props.customColor2), null);
                if (autoCustom) colorState.mode = "custom";
                reapplyColors();
            }
            if (props.colorCycleSpeed !== undefined) {
                if (ctx.setColorCycleSpeed) ctx.setColorCycleSpeed(Number(value(props.colorCycleSpeed)));
            }
            if (props.rgbSpeed !== undefined) {
                if (ctx.setRgbSpeed) ctx.setRgbSpeed(Number(value(props.rgbSpeed)));
            }
            if (props.brightness !== undefined) {
                if (ctx.setBrightness) ctx.setBrightness(Number(value(props.brightness)));
            }
            if (props.adaptiveQuality !== undefined) {
                if (ctx.setAdaptiveQuality) ctx.setAdaptiveQuality(Boolean(value(props.adaptiveQuality)));
            }
            if (props.backgroundColor) {
                const c = Marimo.colorModes.parseColor(value(props.backgroundColor),
                    { r: 0.027, g: 0.035, b: 0.043 });
                scene.background = new THREE.Color(c.r, c.g, c.b);
                renderer.setClearColor(new THREE.Color(c.r, c.g, c.b), 1.0);
                ball.setBodyColor(c);
            }
            if (props.groundShadow !== undefined) {
                if (ctx.setGroundVisible) ctx.setGroundVisible(Boolean(value(props.groundShadow)));
            }
            if (props.mouseInteraction !== undefined) {
                setMouseEnabled(Boolean(value(props.mouseInteraction)));
            }
            if (props.mouseFollow !== undefined) {
                if (ctx.setMouseFollow) ctx.setMouseFollow(Boolean(value(props.mouseFollow)));
            }
            // DVD speed must be set before DVD mode so the seeded velocity
            // uses the right magnitude.
            if (props.dvdSpeed !== undefined) {
                if (ctx.setDvdSpeed) ctx.setDvdSpeed(Number(value(props.dvdSpeed)));
            }
            if (props.dvdMode !== undefined) {
                if (ctx.setDvdMode) ctx.setDvdMode(Boolean(value(props.dvdMode)));
            }
            if (props.idleDrift !== undefined) {
                if (ctx.setIdleDrift) ctx.setIdleDrift(Boolean(value(props.idleDrift)));
            }
            if (props.idleDriftSpeed !== undefined) {
                if (ctx.setIdleDriftSpeed) ctx.setIdleDriftSpeed(Number(value(props.idleDriftSpeed)));
            }
            if (props.cameraDistance) {
                if (ctx.setCameraZoom) ctx.setCameraZoom(Number(value(props.cameraDistance)));
            }
            if (props.bloom !== undefined) {
                if (ctx.setBloom) ctx.setBloom(Boolean(value(props.bloom)));
            }
            if (props.bloomStrength !== undefined) {
                if (ctx.setBloomStrength) ctx.setBloomStrength(Number(value(props.bloomStrength)));
            }
            if (props.debugOverlay !== undefined) {
                setDebugVisible(Boolean(value(props.debugOverlay)));
            }
            if (props.rgbSync !== undefined) {
                // Tolerate the old bool form (true → "bottom") for users with
                // a saved value from version <=5 of the wallpaper.
                let v = value(props.rgbSync);
                if (typeof v === "boolean") v = v ? "bottom" : "off";
                if (ctx.setRgbSync) ctx.setRgbSync(String(v));
            }
            if (props.audioReactivity !== undefined) {
                if (ctx.setAudioReactivity) ctx.setAudioReactivity(Number(value(props.audioReactivity)));
            }
            if (props.audioBounce !== undefined && ctx.setAudioReact) ctx.setAudioReact("bounce", Boolean(value(props.audioBounce)));
            if (props.audioPulse  !== undefined && ctx.setAudioReact) ctx.setAudioReact("pulse",  Boolean(value(props.audioPulse)));
            if (props.audioGlow   !== undefined && ctx.setAudioReact) ctx.setAudioReact("glow",   Boolean(value(props.audioGlow)));
            if (props.audioHair   !== undefined && ctx.setAudioReact) ctx.setAudioReact("hair",   Boolean(value(props.audioHair)));

            // After the first batch (the initial full property load), later
            // batches are treated as live user edits for the custom-color
            // auto-switch logic above.
            firstBatchDone = true;
        }

        function applyGeneral(props) {
            if (!props) return;
            if (props.fps) {
                const fps = Number(value(props.fps));
                if (Number.isFinite(fps)) limiter.setTargetFps(fps);
            }
            // WE's user-picked scheme colour (general property "schemecolor",
            // "r g b" floats). Store it; if the active colour mode follows the
            // scheme, refresh so it retints live.
            if (props.schemecolor !== undefined) {
                const c = Marimo.colorModes.parseColor(value(props.schemecolor), null);
                if (c) {
                    Marimo.colorModes.setSchemeColor(c);
                    if (colorState.mode === "scheme" && !colorState.rgbMode) reapplyColors();
                }
            }
            // Wallpaper Engine sends the `paused` general property when the
            // wallpaper is paused (a game went fullscreen, etc.). When true
            // we stop simulating + rendering until it flips back.
            if (props.paused !== undefined) {
                if (ctx.setPaused) ctx.setPaused(Boolean(value(props.paused)));
            }
        }

        // Install real handlers and replay buffered properties.
        global.__marimoApplyUser__ = applyUser;
        global.__marimoApplyGeneral__ = applyGeneral;

        const pending = global.__MARIMO_PENDING_PROPS__;
        if (pending) {
            if (pending.general) applyGeneral(pending.general);
            if (pending.user) applyUser(pending.user);
            global.__MARIMO_PENDING_PROPS__ = { user: null, general: null };
        }
    }

    Marimo.WallpaperEngineProperties = { attach: attach };
})(window);
