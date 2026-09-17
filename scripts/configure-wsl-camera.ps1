param(
    [string]$DistroName = 'Ubuntu-26.04',
    [string]$LanHost = '',
    [string]$LanCidr = '',
    [string]$WslUserProfile = $env:USERPROFILE,
    [switch]$SkipDistroCheck
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Stop-KplSetup([string]$Message) {
    throw "KPL camera setup: $Message"
}

function Set-IniValue(
    [string]$Text,
    [string]$Section,
    [string]$Key,
    [string]$Value
) {
    $newline = "`r`n"
    $normalized = $Text -replace "`r?`n", $newline
    $sectionPattern = "(?ims)^(?<header>\s*\[$([regex]::Escape($Section))\]\s*\r\n)(?<body>.*?)(?=^\s*\[|\z)"
    $sectionMatch = [regex]::Match($normalized, $sectionPattern)
    if (-not $sectionMatch.Success) {
        if ($normalized.Length -gt 0 -and -not $normalized.EndsWith($newline)) { $normalized += $newline }
        return "$normalized$($newline)[$Section]$newline$Key=$Value$newline"
    }

    $body = $sectionMatch.Groups['body'].Value
    $keyPattern = "(?im)^\s*$([regex]::Escape($Key))\s*=.*(?:\r\n|$)"
    if ([regex]::IsMatch($body, $keyPattern)) {
        $body = [regex]::Replace($body, $keyPattern, "$Key=$Value$newline")
    } else {
        $body = "$Key=$Value$newline$body"
    }
    $replacement = $sectionMatch.Groups['header'].Value + $body
    return $normalized.Remove($sectionMatch.Index, $sectionMatch.Length).Insert($sectionMatch.Index, $replacement)
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-KplSetup 'falta elevacion. Abre PowerShell con "Ejecutar como administrador" y repite el comando del README.'
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Stop-KplSetup 'wsl.exe no esta instalado o no esta disponible en PATH.'
}

if (-not $SkipDistroCheck) {
    $installedDistros = @(& wsl.exe --list --quiet 2>$null) | ForEach-Object {
        ($_ -replace [string][char]0, '').Trim()
    } | Where-Object { $_ -ne '' }
    if ($installedDistros -notcontains $DistroName) {
        Stop-KplSetup "la distribucion '$DistroName' no existe para la cuenta de Windows actual. Compruebala con 'wsl --list --verbose'. Si esta consola elevada usa otra cuenta, verifica WSL antes de elevar y ejecuta este script con -SkipDistroCheck y -WslUserProfile."
    }

    $verboseList = ((& wsl.exe --list --verbose 2>&1 | Out-String) -replace [string][char]0, '')
    $distroPattern = "(?im)^\s*\*?\s*$([regex]::Escape($DistroName))\s+\S+\s+([12])\s*$"
    $distroMatch = [regex]::Match($verboseList, $distroPattern)
    if (-not $distroMatch.Success) {
        Stop-KplSetup "no se pudo confirmar la version de '$DistroName'. Ejecuta 'wsl --list --verbose' y comprueba que la columna VERSION sea 2."
    }
    if ($distroMatch.Groups[1].Value -ne '2') {
        Stop-KplSetup "'$DistroName' usa WSL 1. Convierte la distribucion con: wsl --set-version $DistroName 2"
    }
} else {
    Write-Host "Comprobacion de '$DistroName' omitida porque WSL pertenece a otra cuenta de Windows."
}

$windowsBuild = [Environment]::OSVersion.Version.Build
$wslVersionOutput = ((& wsl.exe --version 2>&1 | Out-String) -replace [string][char]0, '')
$wslVersionMatch = [regex]::Match($wslVersionOutput, '(?m)^[^:\r\n]+:\s*(\d+\.\d+\.\d+(?:\.\d+)?)')
if (-not $wslVersionMatch.Success) {
    Stop-KplSetup "no se pudo leer la version de WSL. Ejecuta 'wsl --update' y vuelve a intentarlo."
}
$wslVersion = [version]$wslVersionMatch.Groups[1].Value
if ($windowsBuild -lt 22621 -or $wslVersion -lt [version]'2.0.9') {
    Stop-KplSetup "networkingMode=mirrored requiere Windows 11 22H2 (build 22621) o posterior y WSL 2.0.9 o posterior. Detectado: build $windowsBuild, WSL $wslVersion. Actualiza Windows, ejecuta 'wsl --update' y repite."
}

if ([string]::IsNullOrWhiteSpace($LanHost) -or [string]::IsNullOrWhiteSpace($LanCidr)) {
    $activeConfig = Get-NetIPConfiguration | Where-Object {
        $_.NetAdapter.Status -eq 'Up' -and
        $null -ne $_.IPv4DefaultGateway -and
        $_.InterfaceAlias -notmatch '^(vEthernet|Docker|Loopback)'
    } | Sort-Object { $_.NetIPv4Interface.InterfaceMetric } | Select-Object -First 1
    $activeAddress = $activeConfig.IPv4Address | Where-Object {
        $_.IPAddress -notlike '169.254.*'
    } | Select-Object -First 1
    if ($null -eq $activeAddress) {
        Stop-KplSetup 'no se pudo detectar la IPv4 de la red activa. Indica -LanHost y -LanCidr manualmente.'
    }
    $LanHost = $activeAddress.IPAddress
    $prefix = [int]$activeAddress.PrefixLength
    $bytes = ([Net.IPAddress]::Parse($LanHost)).GetAddressBytes()
    $addressValue = ([uint32]$bytes[0] -shl 24) -bor ([uint32]$bytes[1] -shl 16) -bor
        ([uint32]$bytes[2] -shl 8) -bor [uint32]$bytes[3]
    $mask = if ($prefix -eq 0) { [uint32]0 } else { [uint32]::MaxValue -shl (32 - $prefix) }
    $networkValue = $addressValue -band $mask
    $LanCidr = '{0}.{1}.{2}.{3}/{4}' -f
        (($networkValue -shr 24) -band 255), (($networkValue -shr 16) -band 255),
        (($networkValue -shr 8) -band 255), ($networkValue -band 255), $prefix
    Write-Host "Red activa detectada: $LanHost ($LanCidr)"
}

$parsedHost = $null
if (-not [Net.IPAddress]::TryParse($LanHost, [ref]$parsedHost) -or $parsedHost.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    Stop-KplSetup "LanHost debe ser una direccion IPv4 valida; recibido: '$LanHost'."
}
if ($LanCidr -notmatch '^(?:\d{1,3}\.){3}\d{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$') {
    Stop-KplSetup "LanCidr debe ser un CIDR IPv4 valido; recibido: '$LanCidr'."
}
$cidrAddress = $null
if (-not [Net.IPAddress]::TryParse(($LanCidr -split '/', 2)[0], [ref]$cidrAddress) -or
    $cidrAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    Stop-KplSetup "LanCidr debe contener una direccion IPv4 valida; recibido: '$LanCidr'."
}
$hostAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanHost -ErrorAction SilentlyContinue
if ($null -eq $hostAddress) {
    Stop-KplSetup "Windows no tiene ahora la IP $LanHost. Comprueba 'Get-NetIPAddress -AddressFamily IPv4' y corrige LanHost antes de abrir el acceso."
}

$requiredFirewallCommands = @(
    'Get-NetFirewallRule',
    'New-NetFirewallRule',
    'Set-NetFirewallRule',
    'Get-NetFirewallHyperVRule',
    'New-NetFirewallHyperVRule',
    'Set-NetFirewallHyperVRule'
)
foreach ($command in $requiredFirewallCommands) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        Stop-KplSetup "Windows no ofrece el cmdlet $command. Instala las actualizaciones pendientes de Windows 11 y vuelve a ejecutar el script."
    }
}

if (-not (Test-Path -LiteralPath $WslUserProfile -PathType Container)) {
    Stop-KplSetup "no existe el perfil de Windows '$WslUserProfile'. Ejecuta el script con la misma cuenta que posee WSL o indica -WslUserProfile."
}
$configPath = Join-Path $WslUserProfile '.wslconfig'
$currentConfig = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw } else { '' }
$updatedConfig = Set-IniValue $currentConfig 'wsl2' 'networkingMode' 'mirrored'
$updatedConfig = Set-IniValue $updatedConfig 'wsl2' 'firewall' 'true'
$updatedConfig = Set-IniValue $updatedConfig 'experimental' 'hostAddressLoopback' 'true'
$configChanged = $updatedConfig -ne ($currentConfig -replace "`r?`n", "`r`n")
if ($configChanged) {
    if (Test-Path -LiteralPath $configPath) {
        $backupPath = "$configPath.kpl-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item -LiteralPath $configPath -Destination $backupPath
        Write-Host "Copia de seguridad: $backupPath"
    }
    Set-Content -LiteralPath $configPath -Value $updatedConfig -Encoding Ascii
    Write-Host "Configurado networkingMode=mirrored, firewall=true y hostAddressLoopback=true en $configPath"
} else {
    Write-Host "WSL ya tiene networkingMode=mirrored, firewall=true y hostAddressLoopback=true en $configPath"
}

$wslCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$rules = @(
    @{ WindowsName = 'KPL-Camera-TCP'; HyperVName = 'KPL-Camera-HyperV-TCP'; Protocol = 'TCP'; Ports = @('4310', '8889') },
    @{ WindowsName = 'KPL-Camera-UDP'; HyperVName = 'KPL-Camera-HyperV-UDP'; Protocol = 'UDP'; Ports = @('8189') }
)
foreach ($rule in $rules) {
    $windowsRule = Get-NetFirewallRule -Name $rule.WindowsName -ErrorAction SilentlyContinue
    if ($null -eq $windowsRule) {
        New-NetFirewallRule -Name $rule.WindowsName -DisplayName $rule.WindowsName -Description 'KPL camera from the active local subnet' `
            -Enabled True -Profile Any -Direction Inbound -Action Allow -Protocol $rule.Protocol `
            -LocalAddress Any -LocalPort $rule.Ports -RemoteAddress LocalSubnet | Out-Null
    } else {
        Set-NetFirewallRule -Name $rule.WindowsName -Description 'KPL camera from the active local subnet' `
            -Enabled True -Profile Any -Direction Inbound -Action Allow -Protocol $rule.Protocol `
            -LocalAddress Any -LocalPort $rule.Ports -RemoteAddress LocalSubnet | Out-Null
    }

    # Hyper-V projects host firewall rules as read-only HostFirewallLocal entries.
    # A distinct name ensures that this is an editable rule in PersistentStore.
    $hyperVRule = Get-NetFirewallHyperVRule -PolicyStore PersistentStore -Name $rule.HyperVName -ErrorAction SilentlyContinue
    if ($null -eq $hyperVRule) {
        New-NetFirewallHyperVRule -PolicyStore PersistentStore -Name $rule.HyperVName -DisplayName $rule.HyperVName `
            -Enabled True -Profiles Any `
            -Direction Inbound -Action Allow -VMCreatorId $wslCreatorId -Protocol $rule.Protocol `
            -LocalAddresses Any -LocalPorts $rule.Ports -RemoteAddresses LocalSubnet | Out-Null
    } else {
        Set-NetFirewallHyperVRule -PolicyStore PersistentStore -Name $rule.HyperVName -Enabled True `
            -Profiles Any -Direction Inbound -Action Allow -VMCreatorId $wslCreatorId `
            -Protocol $rule.Protocol -LocalAddresses Any -LocalPorts $rule.Ports `
            -RemoteAddresses LocalSubnet | Out-Null
    }
}

Write-Host ''
Write-Host "Reglas adaptables instaladas para la subred local: TCP 4310/8889 y UDP 8189."
Write-Host 'No se han abierto 8554, 9998 ni puertos del router.'
Write-Host ''
Write-Host 'PASO OBLIGATORIO: guarda cualquier trabajo abierto en WSL y ejecuta:' -ForegroundColor Yellow
Write-Host '  wsl --shutdown' -ForegroundColor Yellow
Write-Host "Despues inicia $DistroName de nuevo, levanta Compose y genera un enlace de camara nuevo."
