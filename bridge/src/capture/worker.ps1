#requires -Version 5.1
<#
  Studio Live capture worker (Windows PowerShell 5.1).

  Protocol: one JSON command per stdin line -> exactly one JSON result line on stdout,
  carrying the request's "id". stdout is reserved for results; diagnostics go to stderr.
  The Node side (bridge/src/capture/index.ts) owns spawning, timeouts and restarts.

  Commands:
    {"id","cmd":"ping"}
    {"id","cmd":"list"}                                   -> {ok,windows:[{hwnd,pid,title,rect,minimized,foreground}]}
    {"id","cmd":"capture", hwnd?, titleMatch?, maxWidth, format, quality, region?, outPath, restore}
                                                          -> {ok,path,width,height,bytes,ms,title,hwnd,pid}
    {"id","cmd":"restore","hwnd"}                         -> {ok,hwnd,minimized}
  Failures: {"id",ok:false,code:"no_window"|"minimized"|"capture_failed"|"bad_request",message}
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Off

# Raw UTF-8 streams: [Console]::InputEncoding/OutputEncoding need a console codepage,
# which does not exist when we are spawned with pipes and no console window.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stderr = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), $utf8)
$stderr.AutoFlush = $true

function Write-Diag([string]$message) { $stderr.WriteLine("worker: $message") }

$startup = [System.Diagnostics.Stopwatch]::StartNew()

Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SLWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    const int SW_SHOWNOACTIVATE = 4;
    const uint PW_RENDERFULLCONTENT = 2;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    const int DWMWA_CLOAKED = 14;
    static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

    public static List<IntPtr> TopLevelWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    public static string GetTitle(IntPtr h)
    {
        int len = GetWindowTextLengthW(h);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static uint GetPid(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    public static RECT GetRect(IntPtr h)
    {
        RECT r;
        GetWindowRect(h, out r);
        return r;
    }

    // Size the window will have once un-minimized (minimized windows report a 160x28 rect at -32000,-32000).
    public static RECT GetNormalRect(IntPtr h)
    {
        var wp = new WINDOWPLACEMENT();
        wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        GetWindowPlacement(h, ref wp);
        return wp.rcNormalPosition;
    }

    public static bool IsCloaked(IntPtr h)
    {
        int cloaked;
        return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
    }

    // Un-minimize without taking focus: show without activation, then park at the bottom of the Z-order.
    public static void ShowWithoutActivating(IntPtr h)
    {
        ShowWindow(h, SW_SHOWNOACTIVATE);
        SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    // 0 on success, otherwise the Win32 error (or -1 when PrintWindow failed without setting one).
    public static int PrintWindowFull(IntPtr h, IntPtr hdc)
    {
        if (PrintWindow(h, hdc, PW_RENDERFULLCONTENT)) return 0;
        int err = Marshal.GetLastWin32Error();
        return err == 0 ? -1 : err;
    }
}
'@

# Physical pixels everywhere: without this GetWindowRect is DPI-virtualised and the bitmap would not match the window.
[void][SLWin32]::SetProcessDPIAware()

function Fail([string]$code, [string]$message) {
    $e = New-Object System.Exception($message)
    $e.Data['code'] = $code
    throw $e
}

function ConvertTo-Hwnd($value) {
    $text = [string]$value
    $n = 0L
    if (-not [int64]::TryParse($text, [ref]$n) -or $n -le 0) { Fail 'no_window' "hwnd must be a positive decimal string, got '$text'" }
    return [IntPtr]$n
}

function Get-Area([SLWin32+RECT]$r) {
    return [int64][math]::Max(0, $r.Right - $r.Left) * [int64][math]::Max(0, $r.Bottom - $r.Top)
}

function New-WindowRecord([IntPtr]$h, [int]$ownerPid, [IntPtr]$foreground) {
    $rect = [SLWin32]::GetRect($h)
    $minimized = [SLWin32]::IsIconic($h)
    $area = if ($minimized) { Get-Area ([SLWin32]::GetNormalRect($h)) } else { Get-Area $rect }
    return [pscustomobject]@{
        hwnd       = $h
        pid        = $ownerPid
        title      = [SLWin32]::GetTitle($h)
        x          = $rect.Left
        y          = $rect.Top
        width      = $rect.Right - $rect.Left
        height     = $rect.Bottom - $rect.Top
        minimized  = [bool]$minimized
        foreground = ($h -eq $foreground)
        area       = $area
    }
}

# Visible top-level windows of every RobloxStudioBeta process whose title mentions Roblox Studio, in Z-order (topmost first).
function Get-StudioWindows {
    $owners = @{}
    foreach ($p in @(Get-Process -Name 'RobloxStudioBeta' -ErrorAction SilentlyContinue)) { $owners[[uint32]$p.Id] = $true }
    $found = New-Object System.Collections.Generic.List[object]
    if ($owners.Count -eq 0) { return ,$found }
    $foreground = [SLWin32]::GetForegroundWindow()
    foreach ($h in [SLWin32]::TopLevelWindows()) {
        $ownerPid = [SLWin32]::GetPid($h)
        if (-not $owners.ContainsKey($ownerPid)) { continue }
        if (-not [SLWin32]::IsWindowVisible($h)) { continue }
        if ([SLWin32]::IsCloaked($h)) { continue }
        $title = [SLWin32]::GetTitle($h)
        if ($title.IndexOf('Roblox Studio', [StringComparison]::Ordinal) -lt 0) { continue }
        $record = New-WindowRecord $h ([int]$ownerPid) $foreground
        if ($record.area -le 0) { continue }
        $found.Add($record)
    }
    return ,$found
}

function ConvertTo-WindowJson($w) {
    return @{
        hwnd       = $w.hwnd.ToInt64().ToString()
        pid        = [int]$w.pid
        title      = [string]$w.title
        rect       = @{ x = [int]$w.x; y = [int]$w.y; width = [int]$w.width; height = [int]$w.height }
        minimized  = [bool]$w.minimized
        foreground = [bool]$w.foreground
    }
}

# Explicit hwnd wins; otherwise filter by titleMatch, prefer the most recently active Studio process
# (foreground, else topmost in Z-order), and within it the largest window (main window over floating docks).
function Select-Window($req) {
    if ($req.hwnd) {
        $h = ConvertTo-Hwnd $req.hwnd
        if (-not [SLWin32]::IsWindow($h)) { Fail 'no_window' "hwnd $($req.hwnd) is not a window (Studio closed or the handle is stale; run list again)" }
        return New-WindowRecord $h ([int][SLWin32]::GetPid($h)) ([SLWin32]::GetForegroundWindow())
    }
    $all = @(Get-StudioWindows)
    if ($all.Count -eq 0) {
        $running = @(Get-Process -Name 'RobloxStudioBeta' -ErrorAction SilentlyContinue).Count -gt 0
        if ($running) { Fail 'no_window' 'Roblox Studio is running but has no visible top-level window yet' }
        Fail 'no_window' 'Roblox Studio is not running (no RobloxStudioBeta process)'
    }
    $candidates = $all
    if ($req.titleMatch) {
        $needle = [string]$req.titleMatch
        $candidates = @($all | Where-Object { $_.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($candidates.Count -eq 0) {
            $titles = ($all | ForEach-Object { "'" + $_.title + "'" }) -join ', '
            Fail 'no_window' "no Roblox Studio window title contains '$needle' (windows: $titles)"
        }
    }
    $active = @($candidates | Where-Object { $_.foreground })
    $ownerPid = if ($active.Count -gt 0) { $active[0].pid } else { $candidates[0].pid }
    $group = @($candidates | Where-Object { $_.pid -eq $ownerPid })
    return ($group | Sort-Object -Property area -Descending | Select-Object -First 1)
}

function Read-Int($value, [int]$default, [int]$min, [int]$max) {
    if ($null -eq $value) { return $default }
    $n = [int]$value
    return [math]::Min($max, [math]::Max($min, $n))
}

function Resize-Bitmap([System.Drawing.Bitmap]$bmp, [int]$maxWidth) {
    if ($maxWidth -le 0 -or $bmp.Width -le $maxWidth) { return $bmp }
    $newHeight = [int][math]::Max(1, [math]::Round($bmp.Height * $maxWidth / $bmp.Width))
    $dst = New-Object System.Drawing.Bitmap($maxWidth, $newHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        # TileFlipXY stops bicubic sampling from bleeding a transparent/black border into the edges.
        $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $dest = New-Object System.Drawing.Rectangle(0, 0, $maxWidth, $newHeight)
        $g.DrawImage($bmp, $dest, 0, 0, $bmp.Width, $bmp.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    } finally {
        $attrs.Dispose()
        $g.Dispose()
    }
    $bmp.Dispose()
    return $dst
}

function Crop-Bitmap([System.Drawing.Bitmap]$bmp, $region) {
    $wanted = New-Object System.Drawing.Rectangle([int]$region.x, [int]$region.y, [int]$region.w, [int]$region.h)
    $bounds = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $rect = [System.Drawing.Rectangle]::Intersect($wanted, $bounds)
    if ($rect.Width -le 0 -or $rect.Height -le 0) {
        Fail 'capture_failed' "region $($wanted.X),$($wanted.Y) $($wanted.Width)x$($wanted.Height) lies outside the $($bmp.Width)x$($bmp.Height) window"
    }
    $cropped = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    return $cropped
}

function Save-Image([System.Drawing.Bitmap]$bmp, [string]$outPath, [string]$format, [int]$quality) {
    $dir = [System.IO.Path]::GetDirectoryName($outPath)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    if ($format -eq 'png') {
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        return
    }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    try {
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $bmp.Save($outPath, $codec, $params)
    } finally {
        $params.Dispose()
    }
}

function Invoke-Capture($req) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not $req.outPath) { Fail 'bad_request' 'capture requires outPath' }
    $format = if ($req.format) { ([string]$req.format).ToLowerInvariant() } else { 'jpeg' }
    if ($format -ne 'jpeg' -and $format -ne 'png') { Fail 'bad_request' "format must be jpeg or png, got '$format'" }
    $maxWidth = Read-Int $req.maxWidth 1024 0 16384
    $quality = Read-Int $req.quality 70 1 100
    $restore = if ($null -eq $req.restore) { $true } else { [bool]$req.restore }

    $win = Select-Window $req
    $h = [IntPtr]$win.hwnd
    if ([SLWin32]::IsIconic($h)) {
        if (-not $restore) { Fail 'minimized' "window '$($win.title)' is minimized; PrintWindow cannot capture a minimized window (pass restore=true)" }
        [SLWin32]::ShowWithoutActivating($h)
        Start-Sleep -Milliseconds 400
        if ([SLWin32]::IsIconic($h)) { Fail 'minimized' "window '$($win.title)' is still minimized after a non-activating restore" }
    }

    $rect = [SLWin32]::GetRect($h)
    $w = $rect.Right - $rect.Left
    $hgt = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $hgt -le 0) { Fail 'capture_failed' "window '$($win.title)' has an empty rect (${w}x${hgt})" }

    # 24bpp: PrintWindow leaves alpha at 0 for composited surfaces, which PNG would keep as transparency.
    $bmp = New-Object System.Drawing.Bitmap($w, $hgt, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        try { $err = [SLWin32]::PrintWindowFull($h, $hdc) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
        if ($err -ne 0) { Fail 'capture_failed' "PrintWindow failed for '$($win.title)' (Win32 error $err)" }
        $printMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)

        if ($req.region) { $bmp = Crop-Bitmap $bmp $req.region }
        $sourceWidth = [int]$bmp.Width
        $sourceHeight = [int]$bmp.Height
        $bmp = Resize-Bitmap $bmp $maxWidth
        Save-Image $bmp ([string]$req.outPath) $format $quality
        $bytes = (New-Object System.IO.FileInfo([string]$req.outPath)).Length
        return @{
            ok       = $true
            path     = [string]$req.outPath
            width    = [int]$bmp.Width
            height   = [int]$bmp.Height
            source   = @{ width = $sourceWidth; height = $sourceHeight }
            bytes    = [int64]$bytes
            ms       = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
            print_ms = $printMs
            title    = [string]$win.title
            hwnd     = $h.ToInt64().ToString()
            pid      = [int]$win.pid
        }
    } finally {
        if ($bmp) { $bmp.Dispose() }
    }
}

function Invoke-Restore($req) {
    if (-not $req.hwnd) { Fail 'bad_request' 'restore requires hwnd' }
    $h = ConvertTo-Hwnd $req.hwnd
    if (-not [SLWin32]::IsWindow($h)) { Fail 'no_window' "hwnd $($req.hwnd) is not a window" }
    if ([SLWin32]::IsIconic($h)) {
        [SLWin32]::ShowWithoutActivating($h)
        Start-Sleep -Milliseconds 400
    }
    return @{ ok = $true; hwnd = $h.ToInt64().ToString(); minimized = [bool][SLWin32]::IsIconic($h) }
}

function Invoke-Command-Line($req) {
    switch ([string]$req.cmd) {
        'ping'    { return @{ ok = $true; pong = $true; pid = $PID; uptime_ms = [math]::Round($startup.Elapsed.TotalMilliseconds) } }
        'list'    { return @{ ok = $true; windows = [object[]]@(@(Get-StudioWindows) | ForEach-Object { ConvertTo-WindowJson $_ }) } }
        'capture' { return Invoke-Capture $req }
        'restore' { return Invoke-Restore $req }
        default   { Fail 'bad_request' "unknown cmd '$($req.cmd)'" }
    }
}

Write-Diag "ready pid=$PID startup=$([math]::Round($startup.Elapsed.TotalMilliseconds)) ms"

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = $null
    try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        $res = Invoke-Command-Line $req
    } catch {
        $code = $_.Exception.Data['code']
        if (-not $code) { $code = 'capture_failed' }
        $res = @{ ok = $false; code = [string]$code; message = [string]$_.Exception.Message }
    }
    if ($null -ne $id) { $res['id'] = [string]$id }
    $stdout.WriteLine((ConvertTo-Json -InputObject $res -Compress -Depth 6))
}
