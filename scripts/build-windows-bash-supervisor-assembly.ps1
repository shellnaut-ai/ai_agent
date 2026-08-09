$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSEdition -ne "Desktop") {
  throw "Run this generator with Windows PowerShell 5.1."
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $PSScriptRoot "windows-bash-supervisor-helper.cs"
$outputPath = Join-Path $repositoryRoot "src\tools\windows-bash-supervisor-assembly.ts"
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$buildRoot = [IO.Path]::GetFullPath(
  (Join-Path $temporaryRoot ("pi-clone-supervisor-build-" + [guid]::NewGuid().ToString("N"))))

if (!$buildRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create the supervisor build outside the temporary directory."
}

New-Item -ItemType Directory -Path $buildRoot | Out-Null

try {
  $assemblyPath = Join-Path $buildRoot "PiCloneWindowsJobSupervisor.dll"
  Add-Type -Path $sourcePath -OutputAssembly $assemblyPath -OutputType Library

  $assemblyBytes = [IO.File]::ReadAllBytes($assemblyPath)
  $sha256 = [BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash($assemblyBytes)
  ).Replace("-", "").ToLowerInvariant()
  $base64 = [Convert]::ToBase64String($assemblyBytes)
  $chunks = @()

  for ($offset = 0; $offset -lt $base64.Length; $offset += 100) {
    $length = [Math]::Min(100, $base64.Length - $offset)
    $chunks += "  `"$($base64.Substring($offset, $length))`","
  }

  $lines = @(
    "// Generated from scripts/windows-bash-supervisor-helper.cs with Windows",
    "// PowerShell 5.1 Add-Type -OutputType Library. Runtime verifies this digest",
    "// before loading the in-memory .NET Framework assembly.",
    "export const WINDOWS_BASH_SUPERVISOR_ASSEMBLY_SHA256 =",
    "  `"$sha256`";",
    "",
    "export const WINDOWS_BASH_SUPERVISOR_ASSEMBLY_BASE64 = ["
  ) + $chunks + @(
    "].join(`"`");",
    ""
  )
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($outputPath, ($lines -join "`r`n"), $utf8WithoutBom)
  Write-Output "Generated supervisor assembly SHA-256: $sha256"
} finally {
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)

  if (!$resolvedBuildRoot.StartsWith(
    $temporaryRoot,
    [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a supervisor build outside the temporary directory."
  }

  Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
}
