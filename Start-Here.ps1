#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $false }

$dockerHelp = 'https://docs.docker.com/desktop/setup/install/windows-install/'
$defaultImage = 'docker.io/5u8han/vidstream:latest'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Find-DockerDesktop {
    $locations = @()
    if ($env:ProgramFiles) { $locations += (Join-Path $env:ProgramFiles 'Docker\Docker') }
    if ($env:LOCALAPPDATA) { $locations += (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop') }
    foreach ($location in $locations) {
        $desktop = Join-Path $location 'Docker Desktop.exe'
        if (Test-Path -LiteralPath $desktop -PathType Leaf) { return $desktop }
    }
}

function Find-DockerCli {
    $command = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $desktop = Find-DockerDesktop
    if ($desktop) {
        $cli = Join-Path (Split-Path -Parent $desktop) 'resources\bin\docker.exe'
        if (Test-Path -LiteralPath $cli -PathType Leaf) { return $cli }
    }
}

function Install-DockerDesktop {
    if ((Read-Host 'Docker Desktop is required. Download and install it with administrator approval? [y/N]') -notmatch '^(y|yes)$') {
        throw 'Setup stopped before installing Docker Desktop.'
    }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    $architecture = $architecture.ToLowerInvariant()
    if ($architecture -notin @('amd64', 'arm64')) { throw 'Docker Desktop requires 64-bit Windows.' }

    $downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('vidstream-docker-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($downloadDirectory) | Out-Null
    $installer = Join-Path $downloadDirectory 'Docker Desktop Installer.exe'
    try {
        Write-Host 'Downloading Docker Desktop from Docker...'
        $previousProgress = $ProgressPreference
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -UseBasicParsing -Uri "https://desktop.docker.com/win/main/$architecture/Docker%20Desktop%20Installer.exe" -OutFile $installer -TimeoutSec 900
        } finally { $ProgressPreference = $previousProgress }
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)\bDocker[\s,]+Inc\b') {
            throw 'The Docker Desktop installer did not have a valid Docker publisher signature.'
        }
        Write-Host 'Approve the Windows administrator prompt for the Docker Desktop installer.'
        $result = Start-Process -FilePath $installer -ArgumentList @('install', '--backend=wsl-2') -Verb RunAs -Wait -PassThru
        if ($result.ExitCode -in @(1641, 3010)) { throw 'Restart Windows to finish Docker Desktop installation, then open Start-Here.bat again.' }
        if ($result.ExitCode -ne 0) { throw "Docker Desktop installation exited with code $($result.ExitCode). See $dockerHelp" }
    } finally {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Assert-LocalDockerContext {
    $endpoint = $env:DOCKER_HOST
    if ($env:DOCKER_CONTEXT -or -not $endpoint) {
        $context = & $script:docker context show
        if ($LASTEXITCODE -ne 0 -or -not $context) { throw 'Could not determine the current Docker context.' }
        $endpoint = & $script:docker context inspect --format '{{.Endpoints.docker.Host}}' $context
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the current Docker context.' }
    }
    if ([string]$endpoint -notmatch '^npipe:/+\./pipe/[^/\\]+$') {
        throw 'Select a local Docker Desktop context before using folders on this computer.'
    }
}

function Get-DockerServerOS {
    $info = [Diagnostics.ProcessStartInfo]::new($script:docker, 'version --format "{{.Server.Os}}"')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(4000)) {
            if (-not $process.HasExited) { $process.Kill() }
            return
        }
        if ($process.ExitCode -eq 0) { return $output.Result.Trim() }
    } finally { $process.Dispose() }
}

function Start-LocalDocker([switch]$RequireRunning) {
    $serverOS = Get-DockerServerOS
    if (-not $serverOS) {
        if ($RequireRunning) { throw 'Start Docker Desktop, then reopen Start-Here.bat and choose Add a media folder.' }
        $desktop = Find-DockerDesktop
        if (-not $desktop) { throw "Start Docker Desktop and reopen Start-Here.bat. See $dockerHelp" }
        Write-Host 'Starting Docker Desktop. Complete any first-launch prompts in its window.'
        Start-Process -FilePath $desktop
        $deadline = [DateTime]::UtcNow.AddSeconds(120)
        do {
            Start-Sleep -Seconds 3
            Assert-LocalDockerContext
            $serverOS = Get-DockerServerOS
        } until ($serverOS -or [DateTime]::UtcNow -ge $deadline)
        if (-not $serverOS) {
            throw "Docker is still starting. Finish any Docker Desktop or WSL setup, restart Windows if requested, and reopen Start-Here.bat. See $dockerHelp"
        }
    }
    if ($serverOS -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then reopen Start-Here.bat.' }
    & $script:docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose is unavailable. Update Docker Desktop and reopen Start-Here.bat. See $dockerHelp" }
}

function Select-MediaFolder([string]$prompt) {
    if ($script:useFolderPicker) {
        try {
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            try {
                $dialog.Description = $prompt
                $dialog.ShowNewFolderButton = $false
                if ($dialog.PSObject.Properties['UseDescriptionForTitle']) { $dialog.UseDescriptionForTitle = $true }
                if ($dialog.ShowDialog() -eq 'OK') { return $dialog.SelectedPath }
                return
            } finally { $dialog.Dispose() }
        } catch {
            $script:useFolderPicker = $false
            Write-Host 'Folder picker unavailable. Enter folder paths instead.'
        }
    }
    return Read-Host $prompt
}

function Get-ExistingFolder([string]$prompt) {
    while ($true) {
        $inputPath = Select-MediaFolder $prompt
        if ([string]::IsNullOrWhiteSpace($inputPath)) { return }
        $inputPath = $inputPath.Trim('"')
        if ((Test-AbsoluteWindowsPath $inputPath) -and (Test-Path -LiteralPath $inputPath -PathType Container)) {
            $resolved = (Get-Item -LiteralPath $inputPath).FullName
            if ($resolved -match '^[A-Za-z]:[/\\]$') {
                Write-Host 'Choose a media folder inside the drive.'
                continue
            }
            return $resolved.TrimEnd([char[]]'\/')
        }
        Write-Host 'Choose an existing absolute folder path.'
    }
}

function Test-AbsoluteWindowsPath([string]$value) {
    return $value -match '^(?:[A-Za-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)'
}

function Initialize-FolderPicker {
    $script:useFolderPicker = $false
    if ([Environment]::UserInteractive -and [Threading.Thread]::CurrentThread.GetApartmentState() -eq 'STA') {
        try { Add-Type -AssemblyName System.Windows.Forms; $script:useFolderPicker = $true } catch {}
    }
}

function Invoke-StarterCompose([string]$file, [string[]]$dockerArgs) {
    $previousEnvFileSetting = $env:COMPOSE_DISABLE_ENV_FILE
    $previousEnvFiles = $env:COMPOSE_ENV_FILES
    $previousRemoveOrphans = $env:COMPOSE_REMOVE_ORPHANS
    Push-Location -LiteralPath $setupDirectory
    try {
        $env:COMPOSE_DISABLE_ENV_FILE = '1'
        $env:COMPOSE_ENV_FILES = $null
        $env:COMPOSE_REMOVE_ORPHANS = '0'
        & $script:docker compose --project-name vidstream-starter --project-directory $setupDirectory --file $file @dockerArgs
    } finally {
        $env:COMPOSE_DISABLE_ENV_FILE = $previousEnvFileSetting
        $env:COMPOSE_ENV_FILES = $previousEnvFiles
        $env:COMPOSE_REMOVE_ORPHANS = $previousRemoveOrphans
        Pop-Location
    }
}

function Write-ValidatedDraft([string]$yaml) {
    [IO.Directory]::CreateDirectory($setupDirectory) | Out-Null
    $draft = Join-Path $setupDirectory ('.compose-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($draft, $yaml, $utf8)
        Invoke-StarterCompose $draft @('config', '--quiet') | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose rejected the generated configuration.' }
        return $draft
    } catch {
        Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Start-FirstTimeSetup {
    $shippedCompose = Join-Path $PSScriptRoot 'docker-compose.yml'
    foreach ($name in @('compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml')) {
        $existing = Join-Path $setupDirectory $name
        if ($existing -eq $shippedCompose) { continue }
        if (Test-Path -LiteralPath $existing) {
            Write-Host "VidStream is already configured at $existing. Use that Compose file to manage it."
            return
        }
    }

    $port = 8080
    if ($env:VIDSTREAM_PORT -and (-not [int]::TryParse($env:VIDSTREAM_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535)) {
        throw 'VIDSTREAM_PORT must be a number from 1 to 65535.'
    }
    $url = "http://127.0.0.1:$port/"
    $script:docker = Find-DockerCli
    if (-not $script:docker) {
        Install-DockerDesktop
        $script:docker = Find-DockerCli
        if (-not $script:docker) { throw "Restart Windows or reopen Start-Here.bat. See $dockerHelp" }
    }
    Assert-LocalDockerContext
    Start-LocalDocker
    $projectFilter = 'label=com.docker.compose.project=vidstream-starter'
    $existingProject = & $script:docker ps -aq --filter $projectFilter
    if ($LASTEXITCODE -ne 0) { throw 'Could not check for an existing VidStream starter project.' }
    if ($existingProject) { throw 'An existing VidStream starter container already uses this project name. Locate its Compose file before running setup again.' }
    $existingVolumes = & $script:docker volume ls -q --filter $projectFilter
    if ($LASTEXITCODE -ne 0) { throw 'Could not check for existing VidStream starter data.' }
    if ($existingVolumes) { throw 'VidStream starter volumes already exist. Locate their Compose file before running setup again.' }

    $image = $defaultImage
    if ($env:VIDSTREAM_IMAGE) { $image = $env:VIDSTREAM_IMAGE }
    if ($image -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$') { throw 'VIDSTREAM_IMAGE must be a Docker image reference.' }
    Write-Host "Fetching $image..."
    & $script:docker pull $image
    if ($LASTEXITCODE -ne 0) {
        if ($env:VIDSTREAM_IMAGE -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Dockerfile') -PathType Leaf)) {
            throw "Could not pull $image. Check the image name, registry access and network connection."
        }
        $image = 'vidstream-starter:local'
        Write-Host 'The Docker Hub image is unavailable. Building VidStream from this checkout.'
        & $script:docker build --tag $image $PSScriptRoot
        if ($LASTEXITCODE -ne 0) { throw 'The VidStream image build failed.' }
    }

    Initialize-FolderPicker
    Write-Host 'Select the first library. It will open when you sign in.'
    $primary = Get-ExistingFolder 'Choose the first media folder (cancel to stop setup)'
    if (-not $primary) { Write-Host 'Setup cancelled.'; return }
    $folders = @($primary)
    while ((Read-Host 'Add another library folder? [y/N]') -match '^(y|yes)$') {
        $folder = Get-ExistingFolder 'Choose another folder (cancel or Enter to skip)'
        if (-not $folder) { continue }
        if ($folder -notin $folders) { $folders += $folder }
        else { Write-Host 'That folder is already in the list.' }
    }

    $theme = 'light-table'
    $choice = Read-Host 'Theme [1 White, 2 Dark, 3 System] (Enter for White)'
    if ($choice -match '^(2|dark)$') { $theme = 'darkroom' }
    if ($choice -match '^(3|system)$') { $theme = 'system' }

    Assert-LocalDockerContext
    $render = @('run', '--rm', '--network', 'none', $image, 'node', 'scripts/setup-compose.js', $image, "$port", $theme, '--') + $folders
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = $utf8
        $yaml = & $script:docker @render
        if ($LASTEXITCODE -ne 0 -or -not $yaml) { throw 'Could not generate the VidStream Compose file.' }
    } finally { [Console]::OutputEncoding = $previousEncoding }

    $draft = Write-ValidatedDraft (($yaml -join "`n") + "`n")
    try {
        [IO.File]::Move($draft, $composeFile)
    } finally { Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue }

    Assert-LocalDockerContext
    Write-Host "Starting VidStream at $url"
    Invoke-StarterCompose $composeFile @('up', '-d', '--pull', 'never')
    if ($LASTEXITCODE -ne 0) {
        throw "Compose could not start VidStream. Your settings are saved at $composeFile. Resolve the Docker error above, then start the saved Compose project."
    }
    $code = $null
    for ($attempt = 0; $attempt -lt 15 -and -not $code; $attempt++) {
        try { $logs = Invoke-StarterCompose $composeFile @('logs', '--tail', '100', 'stream') 2>$null }
        catch { $logs = @() }
        foreach ($line in $logs) {
            if ($line -match 'Owner setup code:\s+(\S+)') { $code = $Matches[1]; break }
        }
        if (-not $code) { Start-Sleep -Seconds 2 }
    }
    if ($code) { Write-Host "Owner setup code: $code" }
    else { Write-Host 'Read the owner setup code in Docker Desktop under the VidStream stream container logs.' }
    Write-Host "Open $url and use the owner setup code to finish. Settings are saved at $composeFile."
    try { Start-Process $url } catch { Write-Host "Open $url in your browser." }
}

function ConvertTo-NativeArgument([string]$value) {
    $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
}

function Invoke-FolderEditor([string]$image, [string]$editor, [string]$folder, [byte[]]$original) {
    $mount = 'type=bind,"source=' + $editor + '",target=/tmp/vidstream-setup-compose.js,readonly'
    $arguments = @('run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--mount', $mount,
        '--entrypoint', 'node', $image, '/tmp/vidstream-setup-compose.js', '--add-folder', $folder)
    $argumentString = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $info = [Diagnostics.ProcessStartInfo]::new($script:docker, $argumentString)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $stdin = $process.StandardInput.BaseStream
        try { $stdin.Write($original, 0, $original.Length) } finally { $stdin.Dispose() }
        if (-not $process.WaitForExit(30000)) {
            if (-not $process.HasExited) { $process.Kill() }
            throw 'The folder editor timed out.'
        }
        if ($process.ExitCode -ne 0) {
            $message = $errors.Result.Trim()
            if ($message) { throw $message }
            throw 'The folder editor could not run in the existing local VidStream image.'
        }
        if (-not $output.Result) { throw 'The folder editor returned an empty configuration.' }
        return $output.Result
    } finally { $process.Dispose() }
}

function Add-MediaFolder {
    if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
        throw "No starter configuration was found at $composeFile. Choose first-time setup first."
    }
    Assert-PlainComposeFile
    $editor = Join-Path $PSScriptRoot 'scripts\setup-compose.js'
    if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { throw 'Keep Start-Here.bat with the rest of the VidStream download.' }
    $script:docker = Find-DockerCli
    if (-not $script:docker) { throw "Docker Desktop is required to edit the saved project. See $dockerHelp" }

    Initialize-FolderPicker
    $folder = Get-ExistingFolder 'Choose one folder to add (cancel or Enter to stop)'
    if (-not $folder) { Write-Host 'No folder was added.'; return }

    Assert-LocalDockerContext
    Start-LocalDocker -RequireRunning
    $lockPath = Join-Path $setupDirectory '.vidstream-edit.lock'
    try {
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
        throw "Could not lock the starter configuration at $lockPath. Check whether another starter window is editing it."
    }
    try {
        Assert-PlainComposeFile
        $original = [IO.File]::ReadAllBytes($composeFile)
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $originalHash = [BitConverter]::ToString($sha.ComputeHash($original)).Replace('-', '') }
        finally { $sha.Dispose() }
        $images = @(Invoke-StarterCompose $composeFile @('config', '--images', 'stream'))
        if ($LASTEXITCODE -ne 0 -or $images.Count -ne 1 -or $images[0] -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$') {
            throw 'Could not identify the existing VidStream stream image.'
        }
        Assert-LocalDockerContext
        $yaml = Invoke-FolderEditor $images[0] $editor $folder $original
        $draft = Write-ValidatedDraft $yaml
        try {
            Assert-PlainComposeFile
            if ((Get-FileHash -LiteralPath $composeFile -Algorithm SHA256).Hash -ne $originalHash) {
                throw 'The Compose file changed during setup. Run Add a media folder again.'
            }
            [IO.File]::Replace($draft, $composeFile, [NullString]::Value)
        } finally { Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue }
    } finally {
        $lock.Dispose()
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }

    $quotedFile = "'" + $composeFile.Replace("'", "''") + "'"
    $quotedDirectory = "'" + $setupDirectory.Replace("'", "''") + "'"
    $quotedDocker = "'" + $script:docker.Replace("'", "''") + "'"
    Write-Host "Folder added to $composeFile."
    Write-Host 'Run these lines in PowerShell when you want to apply the new mount. The Compose settings apply only to this command.'
    Write-Host 'powershell.exe -NoProfile -Command {'
    Write-Host '    $env:COMPOSE_DISABLE_ENV_FILE = "1"'
    Write-Host '    $env:COMPOSE_ENV_FILES = $null'
    Write-Host '    $env:COMPOSE_REMOVE_ORPHANS = "0"'
    Write-Host "    & $quotedDocker compose --project-name vidstream-starter --project-directory $quotedDirectory --file $quotedFile up -d --pull never --force-recreate stream"
    Write-Host '}'
    Write-Host 'This briefly stops and recreates the VidStream container using the existing image and data volumes. Media folders are mounted read-only.'
}

function Assert-PlainComposeFile {
    $file = Get-Item -LiteralPath $composeFile -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Add a media folder requires the starter Compose file itself, without a symbolic link or other reparse point.'
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run Start-Here.sh on macOS or Linux.' }
    $setupDirectory = $PSScriptRoot
    $legacyDirectory = Join-Path $HOME 'VidStream-setup'
    if ($env:VIDSTREAM_INSTALL_DIR) {
        if (-not (Test-AbsoluteWindowsPath $env:VIDSTREAM_INSTALL_DIR)) {
            throw 'VIDSTREAM_INSTALL_DIR must be an absolute Windows drive or UNC directory path.'
        }
        $setupDirectory = [IO.Path]::GetFullPath($env:VIDSTREAM_INSTALL_DIR)
    } elseif (-not (Test-Path -LiteralPath (Join-Path $setupDirectory 'compose.yaml')) -and
              (Test-Path -LiteralPath (Join-Path $legacyDirectory 'compose.yaml'))) {
        $setupDirectory = $legacyDirectory
    }
    $composeFile = Join-Path $setupDirectory 'compose.yaml'
    Write-Host 'VidStream'
    Write-Host '  1. First-time setup'
    Write-Host '  2. Add a media folder'
    Write-Host '  Q. Quit'
    do { $action = Read-Host 'Choose an option [1/2/Q]' } until ($action -match '^(1|2|q)$')
    if ($action -eq '1') { Start-FirstTimeSetup }
    if ($action -eq '2') { Add-MediaFolder }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
