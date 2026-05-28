# Marimo Wallpaper

A calm, fuzzy, living hairy ball for **Wallpaper Engine** — a Three.js
recreation of the [Marimo](https://oimo.io/works/marimo/) sketch by
[saharan](https://github.com/saharan). Verlet-integrated hair strands on a
slowly rotating sphere, with multiple color modes, soft idle motion,
optional mouse interaction, and tunable density.

![preview placeholder — drop your own preview.jpg in this folder](preview.jpg)

---

## What this is

A self-contained **web wallpaper**: HTML + CSS + JavaScript + a locally
bundled copy of Three.js. No CDNs, no network at runtime, no Node required
to actually run it.

- Three.js scene with a single `LineSegments` mesh holding **all** strands.
- CPU verlet integration on `Float32Array` buffers (8-segment strands by
  default; ~3.5k to 32k strands depending on the quality preset).
- Distance + volume + max-length constraints, mirroring the original
  GPU-texture solver.
- Color modes: natural moss green, RGB "FEVER" rainbow, blue/cyan,
  purple/pink, or two user-picked custom colors.
- Wallpaper Engine user properties for every visible knob.

## File layout

```
marimo-wallpaper/
├── index.html                 entry point — Wallpaper Engine loads this
├── style.css                  full-screen, no chrome
├── project.json               Wallpaper Engine manifest (properties live here)
├── package.json               optional npm helpers for dev — not required
├── LICENSE                    MIT
├── README.md                  this file
├── lib/
│   └── three.min.js           bundled Three.js r160 (the deprecation banner
│                              has been stripped for a clean wallpaper console)
└── src/
    ├── main.js                bootstraps everything, runs the rAF loop
    ├── MarimoBall.js          central sphere body + rotation
    ├── FurSystem.js           hair simulation + LineSegments rendering
    ├── WallpaperEngineProperties.js   property listener glue
    ├── PerformanceLimiter.js  FPS limiter / EMA FPS tracker
    ├── scene/
    │   └── setupScene.js      renderer / camera / lights / fitCamera
    └── util/
        ├── fibonacci.js       even sphere distribution
        ├── noise.js           cheap sinusoidal wind
        └── colorModes.js      color presets + Wallpaper-Engine color parser
```

## Run in a browser (dev)

Two equally good options.

**Option A — just open the file.** Double-click `index.html`. The classic
`<script>` tags mean it works straight from `file://`.

**Option B — local static server.** If your browser blocks any local read
(rare with classic scripts, but possible with strict policies):

```bash
npm run dev
# then open http://localhost:5173
```

`npm run dev` runs a tiny zero-dependency Node server (`.dev-server.js`).
You can also run it directly with `node .dev-server.js` if you don't have
npm. Either way the server only listens on `127.0.0.1`.

Press **D** in the browser window to toggle the debug overlay (FPS, hair
count, DPR, resolution).

## Build

There is no build step. The project ships as static files. Whatever lives
in this folder is what Wallpaper Engine consumes.

If you ever want to inline everything into a single file for distribution,
you can use any static bundler (esbuild, rollup, etc.), but it's not
necessary.

## Import into Wallpaper Engine

1. Open **Wallpaper Engine**.
2. Click **Open Wallpaper Editor**.
3. Choose **Create Wallpaper**.
4. Pick **Web Wallpaper**.
5. When asked for the source folder / HTML file, point it at this folder's
   **`index.html`**.
6. Wallpaper Engine copies the folder into its own `projects` directory.
7. Set a name and preview image (drop a `preview.jpg` into the folder
   first if you want a custom one).
8. Save. The wallpaper appears in your "Installed" tab and can be applied
   like any other.

## Edit settings in Wallpaper Engine

Right-click the wallpaper in Wallpaper Engine and pick **Configure** (or
just open it while it's applied). Every setting below is exposed:

| Section              | Setting                  | Default | Notes |
|----------------------|--------------------------|---------|-------|
| Quality              | Quality preset           | Medium  | Low / Medium / High / Ultra. Picks the strand count ceiling. |
| Marimo               | Ball size                | 5.0     | Sphere radius in scene units. |
| Marimo               | Hair amount              | 1.0     | Multiplier on the quality preset's strand count. |
| Marimo               | Hair length              | 4.0     | Strand length in scene units. |
| Marimo               | Hair volume              | 0.7     | "Puffiness" — minimum radius per segment. |
| Motion               | Gravity (ball + hair)    | 0.6     | Pulls the ball *and* the hair tips downward. 0 = float in place. |
| Motion               | Ball physics             | On      | When on the ball is a rigid body — falls, bounces, can be nudged by mouse. Off pins it at the origin. |
| Motion               | Ball bounce              | 0.55    | Restitution. 0 = no bounce, 0.9 = very bouncy. |
| Motion               | Auto-rotation speed      | 0.0     | Constant body spin. Default 0 (no auto-spin, matching the original). |
| Motion               | Idle motion / wind       | 0.4     | Sinusoidal sway on the strands. |
| Color                | RGB rainbow mode         | Off     | Overrides color mode; cycles hue with time. |
| Color                | Color mode               | Natural | Natural / RGB neon / Blue-cyan / Purple-pink / Custom / Follow Windows accent. |
| Color                | Custom color (root)      | Dark blue | Used when Color mode = Custom. |
| Color                | Custom color (tip)       | Light cyan | Used when Color mode = Custom. |
| Look                 | Background color         | Near-black | Sets the clear color and tints the body sphere. |
| Look                 | Show ground shadow       | On      | Soft vignette under the ball. |
| Look                 | Camera zoom              | 1.0     | 0.6 = wider, 1.8 = closer. |
| Look                 | Glow (additive blending) | Off     | Strand additive blending — looks great in dark modes, can wash out light backgrounds. |
| Interaction          | Mouse interaction        | On      | Mouse position tilts the marimo. |
| Debug                | Show debug overlay       | Off     | Top-left FPS / hair count chip. |

Wallpaper Engine's own FPS setting (the one in the *general* properties
pane) is respected automatically — `PerformanceLimiter` reads it and caps
frames accordingly. Default fallback is 60.

## Debug inside Wallpaper Engine (CEF DevTools)

1. Wallpaper Engine → **Settings** → **General**.
2. Find **CEF DevTools port** and set it to a port (Steam's default
   suggestion is `8080`).
3. Restart Wallpaper Engine.
4. Open **Chrome** (or any Chromium browser) and visit
   `http://localhost:8080` while the Marimo wallpaper is running.
5. Pick the wallpaper page from the list. You get a full DevTools panel:
   Console, Performance, Memory, etc.

The wallpaper also accepts the keyboard shortcut **D** to toggle the
in-page debug overlay (useful for both browser and CEF).

## Performance notes

| Preset | Strands  | Approx. CPU / frame * | Approx. GPU                |
|--------|----------|-----------------------|----------------------------|
| Low    | 3,500    | ~0.5 ms               | Trivial on any GPU         |
| Medium | 10,000   | ~1.5 ms               | Light, fine on integrated  |
| High   | 20,000   | ~3 ms                 | Mid-range discrete GPU     |
| Ultra  | 32,000   | ~5 ms                 | Recommended discrete GPU   |

\* Measured on a mid-2024 desktop CPU. Your numbers will vary.

Notes:

- The simulation runs on the CPU. The GPU only draws `LineSegments`, which
  is essentially free.
- Strand count = `(quality preset max) × hairAmount slider`. Pull the
  `hairAmount` slider down if you want a lighter version of any preset.
- WebGL line width is fixed at 1 pixel on most platforms (a Three.js
  limitation, not a bug here). Strand visual density is controlled by
  count, not thickness.
- The wallpaper writes one `position` attribute upload per frame, sized to
  the active strand count — no allocations, no `THREE.Mesh` churn.
- Quality changes at runtime never reallocate buffers; only the index
  draw range changes.
- On the **Visibility** event the wallpaper pauses its frame work, so
  occluded / hidden wallpapers don't burn cycles.

## RGB hardware sync

The wallpaper can act as a **color source** for your peripherals — by syncing
the marimo's colors to your Windows accent, and letting your RGB hardware
software sample the screen.

### Follow Windows accent color (built in)

Set **Color mode** = *Follow Windows accent* in the Wallpaper Engine
configure panel.

- The wallpaper reads the live Windows accent via the CSS `AccentColor`
  keyword (CSS Color 4). Supported in current Wallpaper Engine CEF.
- The marimo's strands gradient from a dark variant at the root to the
  full accent at the tip.
- Changes to the Windows accent are picked up within ~1 second
  automatically — no reload, no companion app.

If you switch your Windows accent in **Settings → Personalization →
Colors**, the marimo retints to match.

### Corsair iCUE sync

Wallpaper Engine itself doesn't drive iCUE devices directly — instead,
iCUE's own screen-sampling features pull colors from the wallpaper:

1. Open **Corsair iCUE**.
2. Add a new **Mural** (or **Video Lighting** in newer iCUE versions).
3. Source: **Screen Sample** — point it at your display.
4. Apply the mural to your iCUE devices (keyboard, mouse, fans, strip).
5. Optionally tune the sample regions so they pick from where the
   marimo is on screen.

Now: the marimo glows in the Windows accent (or any color mode), and iCUE
mirrors those colors onto your hardware in real time.

### Razer Chroma sync

Wallpaper Engine has built-in Razer Chroma integration — no extra steps in
this wallpaper. In Wallpaper Engine:

1. **Settings** → **Performance** (or **Plugins** in some versions) →
   enable **Razer Chroma** support.
2. Apply this wallpaper. Wallpaper Engine pipes the dominant on-screen
   colors to your Razer Synapse devices automatically.

### Aurora (third-party, cross-vendor)

If you want one unified sync covering multiple vendors (iCUE, Razer
Synapse, NZXT CAM, Logitech G HUB, etc.), the open-source
[Aurora](https://www.project-aurora.com/) project can sample the screen
and drive all of them at once.

## Customizing further

- **Strand segments**: edit `SEGMENTS` in `src/FurSystem.js`. 6 is a sweet
  spot for stability vs. detail. 8 looks softer but doubles CPU work.
- **Damping**: `_damping` in `FurSystem`. 0.985 is bouncy-but-stable.
  Lower (e.g. 0.97) for a heavier feel.
- **Per-quality strand counts**: the `QUALITY_HAIRS` map at the top of
  `src/FurSystem.js`. Increase Ultra if you have a serious GPU.
- **Adding a color mode**: append to `PRESETS` in
  `src/util/colorModes.js`, then add an `<option>` to the `colorMode`
  combo in `project.json`.

## Credits

- Effect concept and original WebGL implementation:
  [saharan / oimo.io](https://oimo.io/works/marimo/) — MIT.
- This recreation: independent rewrite in Three.js. No original assets
  bundled.
- Three.js: MIT, bundled at `lib/three.min.js`.

## License

MIT — see `LICENSE`.
