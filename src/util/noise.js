/**
 * Cheap 3D value-noise-ish generator for ambient wind.
 *
 * We don't need true Perlin/Simplex — the hairs are short and verlet smooths
 * out a lot. A handful of sinusoids combined with the strand's root direction
 * gives a believable "soft breeze" feel at almost zero CPU cost.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    /**
     * Returns a 3-component wind vector for a given root direction & time.
     * The output is roughly bounded to [-1, 1] per axis; callers scale it.
     */
    function windAt(nx, ny, nz, t) {
        // Three orthogonal sinusoids with prime-ish frequencies & phase offsets,
        // modulated by the surface normal so adjacent strands move similarly.
        const a = Math.sin(t * 0.7 + nx * 2.1 + nz * 1.3);
        const b = Math.sin(t * 0.5 + ny * 1.7 + nx * 0.9 + 1.7);
        const c = Math.sin(t * 0.9 + nz * 2.3 + ny * 1.1 + 3.1);
        return {
            x: a * 0.6 + b * 0.4,
            y: c * 0.3,                 // less vertical wind — keeps the marimo grounded
            z: b * 0.5 - a * 0.4
        };
    }

    Marimo.windAt = windAt;
})(window);
