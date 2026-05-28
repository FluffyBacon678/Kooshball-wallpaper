/**
 * Fibonacci sphere distribution.
 *
 * Returns an array of N Vector3-like {x,y,z} points distributed roughly
 * uniformly over a unit sphere. The golden-angle spiral gives much better
 * even coverage than naive longitude/latitude sampling — no banding at the
 * poles, no clusters at the equator.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996

    /**
     * @param {number} n  number of points
     * @param {boolean} [shuffle=true]  shuffle the output (with a stable seed)
     *   so any *prefix* of the array is still a uniform sphere sample. This
     *   matters: the FurSystem pre-allocates rootDir for the largest quality
     *   preset and only iterates the active prefix — without a shuffle the
     *   first half of the array is the upper hemisphere only.
     * @returns {Float32Array} flat [x0,y0,z0, x1,y1,z1, ...] length n*3
     */
    function fibonacciSphere(n, shuffle) {
        if (shuffle === undefined) shuffle = true;
        const out = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            // y goes from +1-eps down to -1+eps (avoid the exact poles for stability).
            const y = 1 - (i / Math.max(1, n - 1)) * 2;
            const radius = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = GOLDEN_ANGLE * i;
            out[i * 3 + 0] = Math.cos(theta) * radius;
            out[i * 3 + 1] = y;
            out[i * 3 + 2] = Math.sin(theta) * radius;
        }
        if (shuffle) shuffleTriplesInPlace(out, n);
        return out;
    }

    // Fisher-Yates with a tiny xorshift PRNG so the shuffle is deterministic.
    function shuffleTriplesInPlace(arr, n) {
        let s = 0x9E3779B1; // fixed seed → identical layout every load
        function rnd() {
            s ^= s << 13; s >>>= 0;
            s ^= s >>> 17;
            s ^= s << 5;  s >>>= 0;
            return s / 0xFFFFFFFF;
        }
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            if (j === i) continue;
            const ia = i * 3, ja = j * 3;
            const tx = arr[ia], ty = arr[ia + 1], tz = arr[ia + 2];
            arr[ia]     = arr[ja];     arr[ia + 1] = arr[ja + 1]; arr[ia + 2] = arr[ja + 2];
            arr[ja]     = tx;          arr[ja + 1] = ty;          arr[ja + 2] = tz;
        }
    }

    Marimo.fibonacciSphere = fibonacciSphere;
})(window);
