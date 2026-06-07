/**
 * FPS limiter / scheduler.
 *
 * Wallpaper Engine exposes the user-chosen FPS via the `fps` general property.
 * We respect it strictly: if the next-frame deadline hasn't been reached, the
 * frame is skipped (we still call rAF but render is a no-op). Outside of
 * Wallpaper Engine we default to 60.
 *
 * Also tracks an exponential-moving-average FPS for the debug overlay.
 */
(function (global) {
    const Marimo = global.Marimo = global.Marimo || {};

    class PerformanceLimiter {
        constructor() {
            this._targetFps = 60;
            this._frameBudgetMs = 1000 / 60;
            this._lastFrameTime = 0;
            this._emaFps = 60;
            this._emaAlpha = 0.05;
            this._frameCount = 0;
        }

        /**
         * @param {number} fps  desired target; 0/undefined falls back to 60.
         */
        setTargetFps(fps) {
            const safe = (Number.isFinite(fps) && fps > 0) ? fps : 60;
            // Clamp to a sane range so a bad property value can't freeze the wallpaper.
            this._targetFps = Math.min(240, Math.max(15, safe));
            // Subtract a half-millisecond — without it rAF tends to skew one frame slow.
            this._frameBudgetMs = (1000 / this._targetFps) - 0.5;
        }

        getTargetFps() {
            return this._targetFps;
        }

        /**
         * Called each rAF. Returns true if the renderer should run this frame,
         * false if we should skip (FPS cap not yet reached).
         */
        shouldRender(nowMs) {
            if (this._lastFrameTime === 0) {
                this._lastFrameTime = nowMs;
                return true;
            }
            const elapsed = nowMs - this._lastFrameTime;
            if (elapsed < this._frameBudgetMs) return false;
            // We "subtract" instead of overwriting so we don't accumulate drift.
            // If we fall far behind (e.g. tab was hidden), snap forward to now.
            if (elapsed > this._frameBudgetMs * 5) {
                this._lastFrameTime = nowMs;
            } else {
                this._lastFrameTime += this._frameBudgetMs;
            }
            // EMA FPS tracking.
            const instantFps = 1000 / Math.max(0.1, elapsed);
            this._emaFps = this._emaFps + (instantFps - this._emaFps) * this._emaAlpha;
            this._frameCount++;
            return true;
        }

        getMeasuredFps() {
            return this._emaFps;
        }

        getFrameCount() {
            return this._frameCount;
        }
    }

    Marimo.PerformanceLimiter = PerformanceLimiter;
})(window);
