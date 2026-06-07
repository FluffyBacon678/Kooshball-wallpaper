# build-release.ps1
#
# Produces a clean ./release/ folder containing only the files Wallpaper
# Engine consumes — no dev helpers, no preview tooling. Drag that folder's
# index.html into the Wallpaper Engine editor to deploy.

$ErrorActionPreference = "Stop"

# Single canonical upload folder: a sibling of the repo, so it never sits
# inside the project (nothing to accidentally commit) and there's exactly
# one place to drag into Wallpaper Engine.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst  = Join-Path (Split-Path -Parent $root) "marimo-wallpaper-release"

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Path $dst | Out-Null

$include = @(
    "index.html",
    "style.css",
    "project.json",
    "LICENSE",
    "README.md",
    "lib\three.min.js",
    "src\main.js",
    "src\MarimoBall.js",
    "src\FurSystem.js",
    "src\WallpaperEngineProperties.js",
    "src\PerformanceLimiter.js",
    "src\scene\setupScene.js",
    "src\scene\bloom.js",
    "src\util\fibonacci.js",
    "src\util\noise.js",
    "src\util\colorModes.js"
)

foreach ($f in $include) {
    $srcPath = Join-Path $root $f
    $dstPath = Join-Path $dst $f
    $dstDir  = Split-Path $dstPath -Parent
    if (-not (Test-Path $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }
    Copy-Item -Path $srcPath -Destination $dstPath -Force
}

# Optionally copy preview.jpg if it exists (Wallpaper Engine's thumbnail).
$preview = Join-Path $root "preview.jpg"
if (Test-Path $preview) { Copy-Item -Path $preview -Destination (Join-Path $dst "preview.jpg") }

$count = (Get-ChildItem $dst -Recurse -File).Count
$size  = [math]::Round(((Get-ChildItem $dst -Recurse -File | Measure-Object -Sum Length).Sum / 1KB), 1)
Write-Host "Built release/ : $count files, $size KB"
Write-Host "Drag $dst\index.html into the Wallpaper Engine editor."
