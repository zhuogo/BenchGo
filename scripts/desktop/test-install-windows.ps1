param([string]$PreviousInstaller = '')
$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem -Path (Join-Path $PSScriptRoot '../../artifacts/windows') -Filter 'benchgo-*-win-x64-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one BenchGo installer' }
$installer = $installers[0]
$expectedAppVersion = (Get-Content (Join-Path $PSScriptRoot '../../package.json') -Raw | ConvertFrom-Json).version
$previousHome = $env:DSH_HOME
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'benchgo-installer-smoke'

# WScript.Shell can expose the ANSI shell-link target on non-Chinese Windows.
# Read IShellLinkW explicitly so the Unicode executable name remains intact.
if (-not ('BenchGoInstallerShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class BenchGoInstallerShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int capacity);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint capacity);

    public sealed class ShortcutDetails
    {
        public string TargetPath { get; set; }
        public string Arguments { get; set; }
        public string WorkingDirectory { get; set; }
    }

    public static ShortcutDetails Read(string path)
    {
        object instance = new ShellLink();
        try
        {
            ((IPersistFile)instance).Load(path, 0);
            var link = (IShellLinkW)instance;
            var target = new StringBuilder(32768);
            var arguments = new StringBuilder(32768);
            var working = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetWorkingDirectory(working, working.Capacity);
            return new ShortcutDetails { TargetPath = target.ToString(), Arguments = arguments.ToString(), WorkingDirectory = working.ToString() };
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }

    public static string ExistingLongPath(string path)
    {
        if (String.IsNullOrEmpty(path) || !File.Exists(path)) throw new FileNotFoundException("Shortcut target must be an existing file", path);
        var output = new StringBuilder(32768);
        uint length = GetLongPathNameW(Path.GetFullPath(path), output, (uint)output.Capacity);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= output.Capacity) throw new IOException("Shortcut target path exceeds the supported length");
        return output.ToString();
    }
}
'@
}

function Install-Silently([string]$Path) {
    $process = Start-Process -FilePath $Path -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
}
function Get-Installed([string]$Name) {
    $items = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter $Name -Recurse)
    if ($items.Count -ne 1) { throw "Expected one installed $Name, got $($items.Count)" }
    return $items[0]
}
function Assert-Plus([System.IO.FileInfo]$Installed) {
    $manifest = Get-Content (Join-Path $env:DSH_HOME 'profiles/desktop/package.json') -Raw | ConvertFrom-Json
    $state = $manifest.dsh.plusInstall
    if ($null -eq $state -or $manifest.dsh.profile.bundles -notcontains $state.bundleName) { throw 'The installer did not activate managed BenchGo' }
    if (-not (Test-Path (Join-Path $env:DSH_HOME "profiles/desktop/node_modules/$($state.bundleName)/package.json"))) { throw 'The profile-local plugin wrapper is missing' }
    if (-not (Test-Path (Join-Path $Installed.DirectoryName 'resources/benchgo/plugin-bundle.mjs'))) { throw 'The offline plugin bootstrap is missing' }
    if (-not (Test-Path (Join-Path $Installed.DirectoryName 'resources/benchgo/seed/release.json'))) { throw 'The offline plugin seed is missing' }
    $seed = Get-Content (Join-Path $Installed.DirectoryName 'resources/benchgo/seed/release.json') -Raw | ConvertFrom-Json
    if (-not $seed.version -or $state.version -ne $seed.version) { throw "Installed profile plugin version $($state.version) does not match installer seed $($seed.version)" }
    $plugin = Get-Content (Join-Path $state.directory 'node_modules/benchgo-plugin/package.json') -Raw | ConvertFrom-Json
    if ($plugin.name -ne 'benchgo-plugin' -or $plugin.version -ne $seed.version) { throw "Active plugin payload version $($plugin.version) does not match installer seed $($seed.version)" }
    Assert-PluginResolution $Installed $state.version $state.directory
    if (Test-Path (Join-Path $Installed.DirectoryName 'resources/app.asar.unpacked/dsh/node_modules/benchgo-plugin/package.json')) { throw 'BenchGo must be external to the sealed engine runtime' }
    if ($Installed.VersionInfo.ProductName -ne 'BenchGo') { throw 'Executable product name is not BenchGo' }
    $actualAppVersion = ([Version]$Installed.VersionInfo.ProductVersion).ToString(3)
    if ($actualAppVersion -ne $expectedAppVersion) { throw "Installed executable version $actualAppVersion does not match $expectedAppVersion" }
    $entries = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.InstallLocation -eq $Installed.DirectoryName })
    if ($entries.Count -ne 1 -or $entries[0].DisplayName -notlike 'BenchGo *') { throw 'Uninstall entry must display BenchGo' }
    $shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/BenchGo.lnk'
    if (-not (Test-Path $shortcut)) { throw 'BenchGo Start Menu shortcut is missing' }

    $shell = New-Object -ComObject WScript.Shell
    $scriptLink = $shell.CreateShortcut($shortcut)
    $nativeLink = [BenchGoInstallerShortcut]::Read($shortcut)
    Write-Output ([ordered]@{ shortcut = $shortcut; installed = $Installed.FullName; wscriptTarget = $scriptLink.TargetPath; nativeTarget = $nativeLink.TargetPath; arguments = $nativeLink.Arguments; workingDirectory = $nativeLink.WorkingDirectory } | ConvertTo-Json -Compress)
    $target = [BenchGoInstallerShortcut]::ExistingLongPath($nativeLink.TargetPath)
    $expected = [BenchGoInstallerShortcut]::ExistingLongPath($Installed.FullName)
    if (-not [String]::Equals($target, $expected, [StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($target) -ne 'BenchGo.exe' -or $nativeLink.Arguments -ne '') { throw 'Start Menu shortcut does not launch BenchGo.exe without arguments' }
}
function Assert-PluginResolution([System.IO.FileInfo]$Installed, [string]$ExpectedVersion, [string]$ExpectedDirectory) {
    $code = @'
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [profile, resources, expectedVersion, expectedDirectory] = process.argv.slice(1);
const runtime = join(resources, 'app.asar.unpacked', 'dsh');
const bootPath = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await import(pathToFileURL(bootPath).href);
const { Context } = createRequire(bootPath)('@deepseek-ai/cordis');
const loaded = loadProfileDirectory('dsh', profile, anchor);
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: loaded, home: dirname(dirname(profile)) });
const ctx = new Context();
try {
  await ctx.plugin(PluginPackages, { resolution });
  const parent = pathToFileURL(join(profile, 'package.json')).href;
  const selected = ctx.pluginPackages.packageOf('benchgo-plugin', parent);
  assert.equal(selected?.version, expectedVersion, 'actual plugin metadata must match the installed version');
  assert.equal(realpathSync.native(selected.dir), realpathSync.native(join(expectedDirectory, 'node_modules/benchgo-plugin')));
  const require = createRequire(parent);
  const manifestPath = join(selected.dir, 'package.json');
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).version, expectedVersion);
  assert.equal(realpathSync.native(require.resolve('benchgo-plugin')), realpathSync.native(join(selected.dir, 'src/plugin.mjs')));
  assert.equal(realpathSync.native(require.resolve('benchgo-plugin/client')), realpathSync.native(join(selected.dir, 'lib/client.js')));
  console.log(`Actual profile plugin resolution passed: ${expectedVersion}`);
} finally { await ctx.fiber.dispose(); }
'@
    $previousNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        # Electron is a GUI-subsystem executable: a pipeline makes PowerShell
        # wait for Node-mode verification before reading its native exit code.
        & $Installed.FullName --expose-internals --input-type=module --eval $code (Join-Path $env:DSH_HOME 'profiles/desktop') (Join-Path $Installed.DirectoryName 'resources') $ExpectedVersion $ExpectedDirectory | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Actual profile plugin resolution failed: $LASTEXITCODE" }
    } finally { $env:ELECTRON_RUN_AS_NODE = $previousNode }
}
function Add-LegacyPluginShadow {
    $directory = Join-Path $env:DSH_HOME 'profiles/desktop/node_modules/benchgo'
    if (Test-Path $directory) { throw 'Legacy shadow fixture must not overwrite an existing package' }
    New-Item (Join-Path $directory 'src') -ItemType Directory -Force | Out-Null
    New-Item (Join-Path $directory 'lib') -ItemType Directory -Force | Out-Null
    $metadata = '{"name":"benchgo","version":"0.1.6","type":"module","main":"./src/plugin.mjs","exports":{".":"./src/plugin.mjs","./client":"./lib/client.js","./package.json":"./package.json"}}'
    # Windows PowerShell 5.1 has no utf8NoBOM; UTF8Encoding(false) keeps the same bytes.
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $directory 'package.json'), $metadata, $utf8)
    [System.IO.File]::WriteAllText((Join-Path $directory 'src/plugin.mjs'), "export default true;`n", $utf8)
    [System.IO.File]::WriteAllText((Join-Path $directory 'lib/client.js'), "export default true;`n", $utf8)
}
try {
    if ($env:BENCHGO_SKIP_FRESH_INSTALL -eq '1') {
        $installed = Get-Installed 'BenchGo.exe'
        Write-Output "Reusing existing installation: $($installed.FullName)"
    } else {
        Install-Silently $installer.FullName
        $installed = Get-Installed 'BenchGo.exe'
        Assert-Plus $installed
        Assert-Plus $installed
        Write-Output "Fresh silent installation passed: $($installed.FullName)"
    }
    Add-LegacyPluginShadow
    $shadowed = Get-Content (Join-Path $env:DSH_HOME 'profiles/desktop/package.json') -Raw | ConvertFrom-Json
    Assert-PluginResolution $installed $shadowed.dsh.plusInstall.version $shadowed.dsh.plusInstall.directory
    Install-Silently $installer.FullName
    Assert-Plus $installed
    if (Test-Path (Join-Path $env:DSH_HOME 'profiles/desktop/node_modules/benchgo')) { throw 'Reinstall left a legacy physical plugin shadow' }
    Write-Output 'Same-version reinstall repaired the legacy physical plugin and resolved the current version.'

    if ($PreviousInstaller) {
        if (-not (Test-Path $PreviousInstaller)) { throw 'Previous installer is missing' }
        $uninstallers = @(Get-ChildItem $installed.DirectoryName -Filter 'Uninstall*.exe')
        if ($uninstallers.Count -ne 1) { throw 'Expected one uninstaller' }
        # Run a copied NSIS uninstaller directly so -Wait covers its full cleanup.
        $uninstaller = Join-Path $env:RUNNER_TEMP 'benchgo-smoke-uninstall.exe'
        Copy-Item $uninstallers[0].FullName $uninstaller -Force
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$($installed.DirectoryName)") -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Uninstaller exited $($process.ExitCode)" }
        Install-Silently (Resolve-Path $PreviousInstaller).Path
        $legacy = Get-Installed 'BenchGo.exe'
        $legacyVersion = ([Version]$legacy.VersionInfo.ProductVersion).ToString(3)
        if ([Version]$legacyVersion -ge [Version]$expectedAppVersion) { throw "Upgrade source $legacyVersion must be older than $expectedAppVersion" }
        $profileMarker = Join-Path $env:DSH_HOME 'benchgo-upgrade-marker.txt'
        $dataDirectory = Join-Path $env:APPDATA 'benchgo-desktop'
        New-Item $dataDirectory -ItemType Directory -Force | Out-Null
        $dataMarker = Join-Path $dataDirectory 'benchgo-upgrade-marker.txt'
        Set-Content $profileMarker 'keep profile'
        Set-Content $dataMarker 'keep desktop data'
        Install-Silently $installer.FullName
        $upgraded = Get-Installed 'BenchGo.exe'
        Assert-Plus $upgraded
        if ($upgraded.DirectoryName -ne $legacy.DirectoryName) { throw 'Upgrade changed the registered installation directory' }
        # v0.0.1 already uses BenchGo.exe and BenchGo.lnk. Same-name upgrades
        # replace those files; their presence is required, not a stale artifact.
        if (-not [String]::Equals($upgraded.FullName, $legacy.FullName, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $legacy.FullName)) { throw 'The previous differently named executable was left behind' }
        if ((Get-Content $profileMarker) -ne 'keep profile' -or (Get-Content $dataMarker) -ne 'keep desktop data') { throw 'Upgrade did not preserve user data' }
        $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
        $desktopShortcut = Join-Path $desktop 'BenchGo.lnk'
        if (Test-Path $desktopShortcut) {
            $link = [BenchGoInstallerShortcut]::Read($desktopShortcut)
            $target = [BenchGoInstallerShortcut]::ExistingLongPath($link.TargetPath)
            $expected = [BenchGoInstallerShortcut]::ExistingLongPath($upgraded.FullName)
            if (-not [String]::Equals($target, $expected, [StringComparison]::OrdinalIgnoreCase) -or $link.Arguments -ne '') { throw 'Upgraded Desktop shortcut does not launch the current BenchGo.exe without arguments' }
        }
        Write-Output "BenchGo in-place upgrade passed: $legacyVersion -> $expectedAppVersion ($($upgraded.FullName))"
    }
} finally {
    $env:DSH_HOME = $previousHome
}
