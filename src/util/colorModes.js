/**
 * Color modes for the marimo fur.
 *
 * Each mode provides:
 *   sample(t, hairIndex, time) -> {r,g,b}
 * where t is the position along the strand (0 = root, 1 = tip).
 *
 * - "natural"  : moss-green gradient (root dark → tip slightly lit).
 * - "rgbNeon"  : original Marimo "FEVER" rainbow, cycles in time.
 * - "blueCyan" : cool blue → cyan gradient.
 * - "purplePink": magenta → pink gradient.
 * - "custom"   : two user-picked colors interpolated by t^2.5.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    function lerp(a, b, t) { return a + (b - a) * t; }

    // Convert an "rrggbb" hex *or* a Wallpaper-Engine "r g b" (0..1 floats) string to {r,g,b}.
    function parseColor(input, fallback) {
        if (!input) return fallback;
        if (typeof input === "object" && "r" in input) return input;
        if (typeof input === "string") {
            const s = input.trim();
            // Wallpaper Engine color format: "0.123 0.456 0.789"
            if (s.indexOf(" ") !== -1) {
                const p = s.split(/\s+/).map(Number);
                if (p.length === 3 && p.every(Number.isFinite)) {
                    return { r: p[0], g: p[1], b: p[2] };
                }
            }
            // CSS hex.
            const hex = s.replace("#", "");
            if (hex.length === 6) {
                return {
                    r: parseInt(hex.slice(0, 2), 16) / 255,
                    g: parseInt(hex.slice(2, 4), 16) / 255,
                    b: parseInt(hex.slice(4, 6), 16) / 255
                };
            }
        }
        return fallback;
    }

    // Two-color t^2.5 ramp — matches the original's `t = pow(t, 2.5); mix(color1, color2, t)`.
    function makeGradient(c1, c2) {
        return function (t /*, hairIndex, time */) {
            const tt = Math.pow(t, 2.5);
            return {
                r: lerp(c1.r, c2.r, tt),
                g: lerp(c1.g, c2.g, tt),
                b: lerp(c1.b, c2.b, tt)
            };
        };
    }

    // RGB "FEVER" mode — direct port of the original shader's sin formula.
    // ang = (vec3(-1/3, 0, 1/3) + t*t*0.5 - time*0.8) * 2*PI
    // color = sin(ang) * 0.5 + 0.5
    const TWO_PI = Math.PI * 2;
    function rgbNeon(t, _hairIndex, time) {
        const base = t * t * 0.5 - time * 0.8;
        return {
            r: Math.sin((base - 1 / 3) * TWO_PI) * 0.5 + 0.5,
            g: Math.sin((base) * TWO_PI) * 0.5 + 0.5,
            b: Math.sin((base + 1 / 3) * TWO_PI) * 0.5 + 0.5
        };
    }

    // HSV → RGB (h,s,v in 0..1). Used by the spatial-rainbow sampler.
    function hsv(h, s, v) {
        h = (h % 1 + 1) % 1;
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: return { r: v, g: t, b: p };
            case 1: return { r: q, g: v, b: p };
            case 2: return { r: p, g: v, b: t };
            case 3: return { r: p, g: q, b: v };
            case 4: return { r: t, g: p, b: v };
            default: return { r: v, g: p, b: q };
        }
    }

    // Spatial rainbow: each strand gets its own hue (golden-ratio spread),
    // brighter toward the tip. Looks like a multicolor koosh ball.
    function rainbow(t, hairIndex /*, time */) {
        const hue = (hairIndex * 0.61803398875) % 1;
        const c = hsv(hue, 0.85, 0.45 + 0.55 * t);
        return c;
    }

    const PRESETS = {
        natural:    makeGradient({ r: 0.04, g: 0.16, b: 0.06 }, { r: 0.55, g: 0.95, b: 0.35 }),
        blueCyan:   makeGradient({ r: 0.02, g: 0.08, b: 0.30 }, { r: 0.35, g: 0.95, b: 1.00 }),
        purplePink: makeGradient({ r: 0.18, g: 0.02, b: 0.30 }, { r: 1.00, g: 0.45, b: 0.85 }),
        // --- extended palettes ---
        sunset:     makeGradient({ r: 0.30, g: 0.05, b: 0.20 }, { r: 1.00, g: 0.62, b: 0.20 }),
        fire:       makeGradient({ r: 0.25, g: 0.02, b: 0.00 }, { r: 1.00, g: 0.85, b: 0.20 }),
        ocean:      makeGradient({ r: 0.01, g: 0.10, b: 0.20 }, { r: 0.10, g: 0.80, b: 0.70 }),
        lavender:   makeGradient({ r: 0.12, g: 0.08, b: 0.22 }, { r: 0.80, g: 0.70, b: 1.00 }),
        gold:       makeGradient({ r: 0.18, g: 0.10, b: 0.00 }, { r: 1.00, g: 0.84, b: 0.40 }),
        autumn:     makeGradient({ r: 0.20, g: 0.06, b: 0.02 }, { r: 0.95, g: 0.50, b: 0.10 }),
        ice:        makeGradient({ r: 0.10, g: 0.16, b: 0.28 }, { r: 0.85, g: 0.95, b: 1.00 }),
        mono:       makeGradient({ r: 0.08, g: 0.08, b: 0.08 }, { r: 0.95, g: 0.95, b: 0.95 }),
        rgbNeon:    rgbNeon,
        rainbow:    rainbow
        // "systemAccent" / "scheme" are built dynamically (see below).
    };

    // --- Hue rotation (fast YIQ matrix). Used for the color-cycle option. ---
    // Returns a function (r,g,b)->{r,g,b}; build the matrix ONCE per frame and
    // reuse it across all vertices (it depends only on the angle).
    function makeHueRotator(angleRad) {
        const U = Math.cos(angleRad), W = Math.sin(angleRad);
        const m00 = 0.299 + 0.701 * U + 0.168 * W;
        const m01 = 0.587 - 0.587 * U + 0.330 * W;
        const m02 = 0.114 - 0.114 * U - 0.497 * W;
        const m10 = 0.299 - 0.299 * U - 0.328 * W;
        const m11 = 0.587 + 0.413 * U + 0.035 * W;
        const m12 = 0.114 - 0.114 * U + 0.292 * W;
        const m20 = 0.299 - 0.300 * U + 1.250 * W;
        const m21 = 0.587 - 0.588 * U - 1.050 * W;
        const m22 = 0.114 + 0.886 * U - 0.203 * W;
        return function (out, r, g, b) {
            out[0] = m00 * r + m01 * g + m02 * b;
            out[1] = m10 * r + m11 * g + m12 * b;
            out[2] = m20 * r + m21 * g + m22 * b;
        };
    }

    // --- Wallpaper Engine scheme color ---
    // WE passes the user's picked scheme color via the `schemecolor` general
    // property ("r g b" floats). We store it and build a dark→scheme gradient.
    let schemeColor = { r: 0.25, g: 0.55, b: 1.00 };
    function setSchemeColor(rgb) { if (rgb) schemeColor = rgb; }
    function getSchemeColor() { return schemeColor; }
    function buildSchemeSampler() {
        const c = schemeColor;
        return makeGradient(
            { r: c.r * 0.10, g: c.g * 0.10, b: c.b * 0.10 },
            { r: Math.min(1, c.r * 1.1), g: Math.min(1, c.g * 1.1), b: Math.min(1, c.b * 1.1) }
        );
    }

    // --- System (Windows) accent color sync ---
    //
    // We use the CSS `AccentColor` system color keyword (CSS Color 4). On
    // modern Chromium / Wallpaper Engine CEF this returns the user's current
    // Windows accent. If the runtime doesn't support the keyword we fall back
    // to a reasonable cool-blue so the wallpaper still works.

    function isSystemAccentSupported() {
        try {
            return typeof CSS !== "undefined"
                && typeof CSS.supports === "function"
                && CSS.supports("color", "AccentColor");
        } catch (_) { return false; }
    }

    // Read the live Windows accent color via a hidden probe element. Returns
    // {r,g,b} in 0..1 floats, or null if the browser doesn't honor the keyword.
    function getSystemAccent() {
        if (!isSystemAccentSupported()) return null;
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;color:AccentColor";
        document.body.appendChild(probe);
        const raw = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        // Parse "rgb(R, G, B)" / "rgba(R, G, B, A)" / "color(srgb R G B)".
        const m = raw && raw.match(/[\d.]+/g);
        if (!m || m.length < 3) return null;
        const a = Number(m[0]), b = Number(m[1]), c = Number(m[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
        // rgb()/rgba() returns 0..255; color(srgb ...) returns 0..1 — detect by magnitude.
        const max = Math.max(a, b, c);
        const scale = max > 1.0001 ? 1 / 255 : 1;
        return { r: a * scale, g: b * scale, b: c * scale };
    }

    function buildSystemAccentSampler() {
        const accent = getSystemAccent() || { r: 0.25, g: 0.55, b: 1.00 };
        // Root color is a darker variant of the accent; tip is the accent
        // itself slightly boosted. The t^2.5 curve in makeGradient keeps the
        // root mostly dark so the body silhouette stays present.
        const root = { r: accent.r * 0.10, g: accent.g * 0.10, b: accent.b * 0.10 };
        const tip = {
            r: Math.min(1, accent.r * 1.10),
            g: Math.min(1, accent.g * 1.10),
            b: Math.min(1, accent.b * 1.10)
        };
        const sampler = makeGradient(root, tip);
        // Tag the sampler so callers can re-build when the accent changes.
        sampler.__accent = accent;
        return sampler;
    }

    /**
     * Resolve a mode name (and optional custom colors) into a sampler function.
     */
    function getSampler(mode, customA, customB) {
        if (mode === "custom") {
            return makeGradient(
                parseColor(customA, { r: 0.05, g: 0.12, b: 0.20 }),
                parseColor(customB, { r: 0.85, g: 0.95, b: 1.00 })
            );
        }
        if (mode === "systemAccent") {
            return buildSystemAccentSampler();
        }
        if (mode === "scheme") {
            return buildSchemeSampler();
        }
        return PRESETS[mode] || PRESETS.natural;
    }

    // True for modes whose colors do not depend on per-vertex lighting and
    // must be regenerated every frame (rgbNeon animates; rainbow is per-hair
    // flat). Gradients are "lit" and only need a static bake.
    function isUnlitMode(mode) {
        return mode === "rgbNeon" || mode === "rainbow";
    }

    Marimo.colorModes = {
        parseColor: parseColor,
        getSampler: getSampler,
        isUnlitMode: isUnlitMode,
        makeHueRotator: makeHueRotator,
        PRESETS: PRESETS,
        getSystemAccent: getSystemAccent,
        isSystemAccentSupported: isSystemAccentSupported,
        buildSystemAccentSampler: buildSystemAccentSampler,
        setSchemeColor: setSchemeColor,
        getSchemeColor: getSchemeColor
    };
})(window);
