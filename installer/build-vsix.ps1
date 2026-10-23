[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$extensionDir = Join-Path $repoRoot 'extension'

function Write-Step([string]$Message) {
    Write-Host "[build-vsix] $Message"
}

function Write-Fail([string]$Message) {
    Write-Host "[失败] $Message" -ForegroundColor Red
}

function New-VsceRef([string]$Kind, [string]$Path) {
    return [pscustomobject]@{ Kind = $Kind; Path = $Path }
}

function Resolve-Vsce {
    $roots = @()
    if ($env:APPDATA) {
        $roots += (Join-Path $env:APPDATA 'npm')
    }
    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path $env:LOCALAPPDATA 'npm')
    }
    try {
        $prefix = (& npm config get prefix 2>$null)
        if ($prefix) {
            $roots += [string]$prefix
        }
    } catch {
        # npm 不在 PATH 时只查默认目录
    }
    foreach ($root in $roots) {
        $cmd = Join-Path $root 'vsce.cmd'
        if (Test-Path $cmd) {
            return New-VsceRef 'cmd' $cmd
        }
        $moduleRoot = Join-Path $root 'node_modules\@vscode\vsce'
        foreach ($entry in @('out\main.js', 'out\cli.js')) {
            $js = Join-Path $moduleRoot $entry
            if (Test-Path $js) {
                return New-VsceRef 'node' $js
            }
        }
    }
    foreach ($base in @($extensionDir, (Join-Path $repoRoot 'desktop'))) {
        $cmd = Join-Path $base 'node_modules\.bin\vsce.cmd'
        if (Test-Path $cmd) {
            return New-VsceRef 'cmd' $cmd
        }
        $js = Join-Path $base 'node_modules\@vscode\vsce\out\main.js'
        if (Test-Path $js) {
            return New-VsceRef 'node' $js
        }
    }
    $command = Get-Command vsce -ErrorAction SilentlyContinue
    if ($command) {
        return New-VsceRef 'cmd' $command.Source
    }
    return $null
}

if (-not (Test-Path (Join-Path $extensionDir 'package.json'))) {
    Write-Fail "未找到扩展目录: $extensionDir"
    exit 1
}
$package = Get-Content -Raw -Encoding UTF8 (Join-Path $extensionDir 'package.json') | ConvertFrom-Json
$version = [string]$package.version
$targetDir = if ($OutputDir) { $OutputDir } else { $extensionDir }
$targetFile = Join-Path $targetDir ("oi-helper-$version.vsix")

$vsce = Resolve-Vsce
if (-not $vsce) {
    Write-Fail '未找到本地 vsce, 请确认以下位置之一存在:'
    Write-Host '  %APPDATA%\npm\node_modules\@vscode\vsce'
    Write-Host '  extension\node_modules\.bin\vsce.cmd'
    Write-Host '  desktop\node_modules\.bin\vsce.cmd'
    exit 2
}

$arguments = @('package', '--pre-release', '--allow-missing-repository', '--out', $targetFile)
$commandName = $vsce.Path
$allArguments = $arguments
if ($vsce.Kind -eq 'node') {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Fail '未找到 node, 无法运行 vsce.'
        exit 2
    }
    $commandName = $node.Source
    $allArguments = @($vsce.Path) + $arguments
}

Write-Step "扩展目录: $extensionDir"
Write-Step "版本: $version"
Write-Step "输出: $targetFile"
Write-Step "vsce: $($vsce.Path)"
Write-Step "命令: `"$commandName`" $($allArguments -join ' ')"

if ($DryRun) {
    Write-Step '[DryRun] 未实际打包.'
    exit 0
}
if ($OutputDir -and -not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Push-Location $extensionDir
try {
    & $commandName @allArguments
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) {
    Write-Fail "vsce package 失败, 退出码 $code."
    exit $code
}
if (-not (Test-Path $targetFile)) {
    Write-Fail "命令成功但未找到产物: $targetFile"
    exit 1
}
$size = [math]::Round((Get-Item $targetFile).Length / 1KB, 1)
Write-Step "打包完成: $targetFile ($size KB)"
exit 0
