# Draws Goldsmith Data's logo (Goldsmith's ingot with a rising price chart)
# on a 128 grid with a transparent background. Saves Logo.tga (128x128,
# 32-bit, for WoW's addon list) here, and 400 and 512 PNGs (CurseForge) to
# PreviewDir.
param([string]$PreviewDir = $PSScriptRoot)

Add-Type -AssemblyName System.Drawing

function C([string]$hex, [int]$a = 255) {
    return [System.Drawing.Color]::FromArgb($a,
        [Convert]::ToInt32($hex.Substring(0, 2), 16),
        [Convert]::ToInt32($hex.Substring(2, 2), 16),
        [Convert]::ToInt32($hex.Substring(4, 2), 16))
}
function P($x, $y) { New-Object System.Drawing.PointF($x, $y) }

function GoldBrush([System.Drawing.RectangleF]$r) {
    $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush($r, (C "fbe7a6"), (C "a47a22"), 45.0)
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $blend.Colors = @((C "fbe7a6"), (C "e8c25a"), (C "a47a22"))
    $blend.Positions = @(0.0, 0.5, 1.0)
    $b.InterpolationColors = $blend
    return $b
}
function SteelBrush([System.Drawing.RectangleF]$r) {
    return New-Object System.Drawing.Drawing2D.LinearGradientBrush($r, (C "c4c9d2"), (C "5f646f"), 90.0)
}

# 32-bit uncompressed TGA, rows bottom to top (TGA's default origin),
# pixels as B, G, R, A
function SaveTga($bmp, [string]$path) {
    $w = $bmp.Width; $h = $bmp.Height
    $header = New-Object byte[] 18
    $header[2] = 2
    $header[12] = $w -band 0xFF; $header[13] = ($w -shr 8) -band 0xFF
    $header[14] = $h -band 0xFF; $header[15] = ($h -shr 8) -band 0xFF
    $header[16] = 32
    $header[17] = 8
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $raw = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($data)
    $pixels = New-Object byte[] ($w * 4 * $h)
    for ($y = 0; $y -lt $h; $y++) {
        [Array]::Copy($raw, ($h - 1 - $y) * $stride, $pixels, $y * $w * 4, $w * 4)
    }
    $out = New-Object byte[] (18 + $pixels.Length)
    [Array]::Copy($header, 0, $out, 0, 18)
    [Array]::Copy($pixels, 0, $out, 18, $pixels.Length)
    [System.IO.File]::WriteAllBytes($path, $out)
}

function DrawLogo([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.ScaleTransform($size / 128.0, $size / 128.0)

    # Chart bars (steel), rising left to right, standing on the ingot
    $barPen = New-Object System.Drawing.Pen((C "3a3d45"), 3)
    $barPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    foreach ($bar in @(@(38, 50), @(57, 38), @(76, 24))) {
        $r = New-Object System.Drawing.RectangleF($bar[0], $bar[1], 14, (68 - $bar[1]))
        $g.FillRectangle((SteelBrush $r), $r)
        $g.DrawRectangle($barPen, $r.X, $r.Y, $r.Width, $r.Height)
    }

    # Ingot (same shape as Goldsmith's)
    $ingotPen = New-Object System.Drawing.Pen((C "7a5a16"), 4)
    $ingotPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $front = [System.Drawing.PointF[]]@((P 10 112), (P 118 112), (P 103 82), (P 25 82))
    $g.FillPolygon((GoldBrush (New-Object System.Drawing.RectangleF(10, 82, 108, 30))), $front)
    $g.DrawPolygon($ingotPen, $front)
    $top = [System.Drawing.PointF[]]@((P 25 82), (P 103 82), (P 92 66), (P 36 66))
    $g.FillPolygon((New-Object System.Drawing.SolidBrush((C "f6dd92"))), $top)
    $g.DrawPolygon($ingotPen, $top)

    # Rising trend line with arrowhead (gold, dark outline)
    $line = [System.Drawing.PointF[]]@((P 16 56), (P 40 40), (P 58 46), (P 98 14))
    $outline = New-Object System.Drawing.Pen((C "5c420d"), 10)
    $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $outline.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($outline, $line)
    $fill = New-Object System.Drawing.Pen((C "f2cf6a"), 5)
    $fill.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $fill.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($fill, $line)
    $head = [System.Drawing.PointF[]]@((P 112 4), (P 106 24), (P 92 10))
    $headPen = New-Object System.Drawing.Pen((C "5c420d"), 3)
    $headPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.FillPolygon((New-Object System.Drawing.SolidBrush((C "f2cf6a"))), $head)
    $g.DrawPolygon($headPen, $head)

    $g.Dispose()
    return $bmp
}

$bmp = DrawLogo 128
SaveTga $bmp (Join-Path $PSScriptRoot "Logo.tga")
$bmp.Save((Join-Path $PreviewDir "Logo.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
foreach ($size in 400, 512) {
    $bmp = DrawLogo $size
    $bmp.Save((Join-Path $PreviewDir "Goldsmith Data Logo $size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
"done"
