# Icon post-processing: crop out the bottom-right watermark, then resize to multiple sizes.
# Uses WPF imaging (PresentationCore, in-box on Windows) which is more reliable than GDI+ ctor binding in PS 5.1.
param(
  [string]$Source = ''
)
Add-Type -AssemblyName PresentationCore

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrEmpty($Source)) { throw 'Source path is required' }
if (-not (Test-Path -LiteralPath $Source)) { throw "Source not found: $Source" }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$assetsLogo = Join-Path $root 'src\renderer\assets\logo.png'
$buildDir = Join-Path $root 'build'
$tmpDir = Join-Path $buildDir 'ico-stages'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $assetsLogo -Parent) | Out-Null

$src = New-Object System.Windows.Media.Imaging.BitmapImage
$src.BeginInit()
$src.UriSource = New-Object System.Uri($Source)
$src.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$src.EndInit()
Write-Output ("SOURCE {0} x {1}" -f $src.PixelWidth, $src.PixelHeight)

# The watermark sits at bottom-right (y >= ~945 of 1024). A centered 860x860 crop removes it fully.
$side = $src.PixelWidth - 164
$offset = [int](($src.PixelWidth - $side) / 2)
$rect = New-Object System.Windows.Int32Rect $offset, $offset, $side, $side
$cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap($src, $rect)
Write-Output ("CROPPED {0} x {1}" -f $cropped.PixelWidth, $cropped.PixelHeight)

function Save-Png($bitmapSource, [string]$outPath) {
  $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmapSource))
  $fs = [System.IO.File]::Create($outPath)
  try { $enc.Save($fs) } finally { $fs.Close() }
}

# Save watermark-free source + UI logo
Save-Png $cropped (Join-Path $buildDir 'icon-src.png')
Save-Png $cropped $assetsLogo
Write-Output ("SAVED {0}" -f $assetsLogo)

# Multi-size stages for png-to-ico
foreach ($size in @(256, 128, 64, 48, 32, 24, 16)) {
  $scale = [double]$size / [double]$side
  $t = New-Object System.Windows.Media.ScaleTransform $scale, $scale
  $resized = New-Object System.Windows.Media.Imaging.TransformedBitmap($cropped, $t)
  $out = Join-Path $tmpDir ("icon-{0}.png" -f $size)
  Save-Png $resized $out
  Write-Output ("STAGE {0}x{0}" -f $size)
}
Write-Output 'ICON STAGES DONE'
