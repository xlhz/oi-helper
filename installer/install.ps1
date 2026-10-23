[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$VsixPath = '',
    [string]$ExtensionDir = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir

function Write-Step([string]$Message) {
    Write-Host "[OI Helper] $Message"
}

function Write-Fail([string]$Message) {
    Write-Host "[失败] $Message" -ForegroundColor Red
}

function Write-Manual([string]$Vsix, [string]$Version) {
    Write-Host "[手动安装] 自动安装未成功, 请按以下步骤操作:" -ForegroundColor Yellow
    Write-Host "  1. 打开编辑器, 按 Ctrl+Shift+P;"
    Write-Host "  2. 执行 Extensions: Install from VSIX...;"
    Write-Host "  3. 选择 $Vsix;"
    Write-Host "  4. 安装后重启编辑器, 扩展版本应为 $Version."
}

function Read-ExtensionVersion([string]$Directory) {
    $packageJson = Join-Path $Directory 'package.json'
    if (-not (Test-Path $packageJson)) {
        return '0.1.0'
    }
    $package = Get-Content -Raw -Encoding UTF8 $packageJson | ConvertFrom-Json
    return [string]$package.version
}

function Resolve-Vsix([string]$ExplicitPath, [string]$Version) {
    if ($ExplicitPath) {
        if (Test-Path $ExplicitPath) {
            return (Resolve-Path $ExplicitPath).Path
        }
        return ''
    }
    $preferred = Join-Path (Join-Path $repoRoot 'extension') ("oi-helper-$Version.vsix")
    if (Test-Path $preferred) {
        return (Resolve-Path $preferred).Path
    }
    $searchDirs = @((Join-Path $repoRoot 'extension'), $scriptDir)
    $found = @()
    foreach ($dir in $searchDirs) {
        if (Test-Path $dir) {
            $found += Get-ChildItem -Path $dir -Filter '*.vsix' -File -ErrorAction SilentlyContinue
        }
    }
    if ($found.Count -eq 0) {
        return ''
    }
    return ($found | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

function Get-UninstallEntries {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $roots) {
        Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
    }
}

function Get-RegistryExe([string]$Pattern) {
    foreach ($entry in (Get-UninstallEntries)) {
        if (-not $entry.DisplayName -or $entry.DisplayName -notmatch $Pattern) {
            continue
        }
        $icon = [string]$entry.DisplayIcon
        if ($icon) {
            $icon = $icon.Trim('"')
            $icon = ($icon -split ',')[0].Trim('"')
            if ($icon -match '\.exe$' -and (Test-Path $icon)) {
                return $icon
            }
        }
        $location = [string]$entry.InstallLocation
        if ($location -and (Test-Path $location)) {
            $exe = Get-ChildItem -Path $location -Filter '*.exe' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '^unins' } |
                Select-Object -First 1
            if ($exe) {
                return $exe.FullName
            }
        }
    }
    return ''
}

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return ''
}

function Find-EditorExe([string]$Name) {
    $names = @()
    if ($Name -eq 'VS Code') {
        $names = @('code.cmd', 'code')
        $known = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
        )
        $registry = Get-RegistryExe '^Microsoft Visual Studio Code( \(User\))?$'
    } elseif ($Name -eq 'VS Code Insiders') {
        $names = @('code-insiders.cmd', 'code-insiders')
        $known = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\Code - Insiders.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft VS Code Insiders\Code - Insiders.exe')
        )
        $registry = Get-RegistryExe 'Visual Studio Code Insiders'
    } else {
        $names = @('trae-cn.cmd', 'trae-cn', 'trae.cmd', 'trae')
        $known = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Trae CN\Trae CN.exe'),
            (Join-Path $env:ProgramFiles 'Trae CN\Trae CN.exe')
        )
        $registry = Get-RegistryExe 'TRAE CN|Trae CN'
    }
    foreach ($path in $known) {
        if ($path -and (Test-Path $path)) {
            return $path
        }
    }
    if ($registry) {
        return $registry
    }
    foreach ($name in $names) {
        $command = Get-CommandPath $name
        if ($command) {
            return $command
        }
    }
    return ''
}

function Get-EditorCommand([string]$EditorPath, [string]$Name) {
    $base = Split-Path -Parent $EditorPath
    $candidates = @()
    if ($Name -eq 'VS Code') {
        $candidates = @('bin\code.cmd', 'bin\code')
    } elseif ($Name -eq 'VS Code Insiders') {
        $candidates = @('bin\code-insiders.cmd', 'bin\code-insiders')
    } else {
        $candidates = @('bin\trae-cn.cmd', 'bin\trae-cn', 'bin\trae.cmd', 'bin\trae')
    }
    foreach ($candidate in $candidates) {
        $full = Join-Path $base $candidate
        if (Test-Path $full) {
            return $full
        }
    }
    return $EditorPath
}

function Get-ExtensionsDir([string]$Name) {
    if ($Name -eq 'VS Code') {
        return (Join-Path $env:USERPROFILE '.vscode\extensions')
    }
    if ($Name -eq 'VS Code Insiders') {
        return (Join-Path $env:USERPROFILE '.vscode-insiders\extensions')
    }
    $cn = Join-Path $env:USERPROFILE '.trae-cn\extensions'
    $intl = Join-Path $env:USERPROFILE '.trae\extensions'
    if (Test-Path $cn) {
        return $cn
    }
    if (Test-Path $intl) {
        return $intl
    }
    return $cn
}

function Get-DetectedEditors {
    $editors = @()
    foreach ($name in @('VS Code', 'VS Code Insiders', 'Trae CN')) {
        $exe = Find-EditorExe $name
        if (-not $exe) {
            continue
        }
        $resolved = (Resolve-Path $exe).Path
        if ($editors | Where-Object { $_.Path -eq $resolved }) {
            continue
        }
        $editors += [pscustomobject]@{
            Name = $name
            Path = $resolved
            Command = Get-EditorCommand $resolved $name
            ExtensionsDir = Get-ExtensionsDir $name
        }
    }
    return $editors
}

function Install-ViaCli($Editor, [string]$Vsix) {
    $arguments = @('--install-extension', $Vsix, '--force')
    Write-Step "尝试 $($Editor.Name): $($Editor.Command) $($arguments -join ' ')"
    if ($DryRun) {
        Write-Step "[DryRun] 跳过实际调用."
        return $true
    }
    $output = & $Editor.Command @arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $output) {
        Write-Host "    $line"
    }
    if ($code -eq 0) {
        Write-Step "$($Editor.Name) 扩展安装成功."
        return $true
    }
    Write-Fail "$($Editor.Name) 的 --install-extension 失败, 退出码 $code, 将回退到目录复制."
    return $false
}

function Install-ViaCopy($Editor, [string]$ExtensionDir, [string]$Version) {
    if (-not $ExtensionDir) {
        Write-Fail '未找到扩展源码目录, 无法回退复制.'
        return $false
    }
    $target = Join-Path $Editor.ExtensionsDir ("oihelper-" + $Version)
    Write-Step "回退复制扩展目录 -> $target"
    if ($DryRun) {
        Write-Step '[DryRun] 跳过实际复制.'
        return $true
    }
    try {
        if (Test-Path $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Copy-Item -Path (Join-Path $ExtensionDir 'package.json') -Destination $target -Force
        foreach ($folder in @('out', 'media')) {
            $source = Join-Path $ExtensionDir $folder
            if (Test-Path $source) {
                Copy-Item -Path $source -Destination $target -Recurse -Force
            }
        }
        if (-not (Test-Path (Join-Path $target 'out\extension.js'))) {
            Write-Fail '复制完成但缺少 out\extension.js, 请先在 extension 目录执行 tsc 编译.'
            return $false
        }
        Write-Step "$($Editor.Name) 扩展已复制, 重启编辑器后生效."
        return $true
    } catch {
        Write-Fail "复制扩展失败: $($_.Exception.Message)"
        return $false
    }
}

Write-Step 'OI Helper 扩展安装开始.'
if ($DryRun) {
    Write-Step '当前为 DryRun 模式, 只打印步骤, 不写文件不调用编辑器.'
}

if (-not $ExtensionDir) {
    $ExtensionDir = Join-Path $repoRoot 'extension'
}
if (-not (Test-Path (Join-Path $ExtensionDir 'package.json'))) {
    $ExtensionDir = ''
}
$version = if ($ExtensionDir) { Read-ExtensionVersion $ExtensionDir } else { '0.1.0' }

$vsix = Resolve-Vsix $VsixPath $version
if (-not $vsix) {
    Write-Fail '未找到扩展安装包 (.vsix).'
    Write-Host "  请先运行: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $scriptDir 'build-vsix.ps1')`""
    Write-Host '  或用 -VsixPath 指定已有的 .vsix 文件.'
    exit 2
}
Write-Step "扩展包: $vsix (版本 $version)"

$editors = @(Get-DetectedEditors)
if ($editors.Count -eq 0) {
    Write-Fail '未检测到 VS Code、VS Code Insiders 或 Trae CN.'
    Write-Host '  桌面程序安装不受影响; 安装编辑器后可重新运行本脚本:'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -VsixPath `"$vsix`""
    exit 1
}
Write-Step "检测到 $($editors.Count) 个编辑器:"
foreach ($editor in $editors) {
    Write-Host "  - $($editor.Name): $($editor.Path)"
}

$failures = 0
foreach ($editor in $editors) {
    Write-Step "处理 $($editor.Name)."
    $installed = Install-ViaCli $editor $vsix
    if (-not $installed) {
        $installed = Install-ViaCopy $editor $ExtensionDir $version
    }
    if (-not $installed) {
        Write-Manual $vsix $version
        $failures += 1
    }
}

if ($DryRun) {
    Write-Step '[DryRun] 结束, 未做任何实际安装.'
    exit 0
}
if ($failures -gt 0) {
    Write-Fail "$failures 个编辑器的扩展安装失败, 请按上方手动安装指引处理."
    exit 1
}
Write-Step '全部编辑器的扩展安装完成.'
exit 0
