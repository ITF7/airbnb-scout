<#
  Renders a scout results JSON file into a standalone HTML report, then rebuilds
  the home page (index.html) listing every past search.
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-report.ps1 -Json results/<run>.json [-Out results/<run>.html]
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-report.ps1 -HomeOnly
#>
param(
  [string]$Json,
  [string]$Out,
  [switch]$HomeOnly
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$resultsDir = Join-Path $root 'results'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-Utf8([string]$path) { [IO.File]::ReadAllText($path, $utf8).TrimStart([char]0xFEFF) }

# Injects $data between the /*DATA_START*/ and /*DATA_END*/ markers of a template.
function Set-Data([string]$templatePath, [string]$data) {
  $html = [IO.File]::ReadAllText($templatePath, $utf8)
  $startTag = '/*DATA_START*/'; $endTag = '/*DATA_END*/'
  $s = $html.IndexOf($startTag); $e = $html.IndexOf($endTag)
  if ($s -lt 0 -or $e -lt $s) { throw "Data markers not found in $templatePath" }
  $safe = $data.Replace('</', '<\/')   # keep the JSON from closing the <script> tag
  return $html.Substring(0, $s + $startTag.Length) + $safe + $html.Substring($e)
}

if (-not $HomeOnly) {
  if (-not $Json) { throw 'Pass -Json <results file> or -HomeOnly' }
  $jsonPath = (Resolve-Path $Json).Path
  if (-not $Out) { $Out = [IO.Path]::ChangeExtension($jsonPath, '.html') }

  $data = Read-Utf8 $jsonPath
  $parsed = $data | ConvertFrom-Json   # fail early on invalid JSON

  $result = Set-Data (Join-Path $root 'templates\report.html') $data
  $city = "$($parsed.filters.location)".Split(',')[0].Trim()
  if ($city) {
    $result = $result.Replace('<title>Airbnb Scout Report</title>', "<title>Scout: $([System.Net.WebUtility]::HtmlEncode($city))</title>")
  }
  [IO.File]::WriteAllText($Out, $result, $utf8)
  Write-Output "Report written: $((Resolve-Path $Out).Path)"
}

# Home page: summary of every results/*.json that has a matching .html report.
$runs = @()
if (Test-Path $resultsDir) {
  foreach ($f in Get-ChildItem $resultsDir -Filter *.json) {
    $html = [IO.Path]::ChangeExtension($f.FullName, '.html')
    if (-not (Test-Path $html)) { continue }
    try { $j = Read-Utf8 $f.FullName | ConvertFrom-Json } catch { continue }
    $listings = @($j.listings)
    $picks = @($listings | Where-Object { -not $_.nearMiss })
    $prices = @($picks | Where-Object { $null -ne $_.totalPrice } | ForEach-Object { [double]$_.totalPrice })
    $cheapest = $null
    if ($prices.Count) { $cheapest = ($prices | Measure-Object -Minimum).Minimum }
    $runs += [pscustomobject]@{
      file        = 'results/' + [IO.Path]::GetFileName($html)
      city        = "$($j.filters.location)".Split(',')[0].Trim()
      checkin     = $j.filters.checkin
      checkout    = $j.filters.checkout
      budget      = $j.filters.budgetTotal
      currency    = $j.filters.currency
      matches     = $picks.Count
      nearMisses  = $listings.Count - $picks.Count
      cheapest    = $cheapest
      query       = $j.query
      generatedAt = $j.generatedAt
    }
  }
}
$runsJson = ConvertTo-Json -InputObject @($runs) -Depth 4 -Compress
if ($runs.Count -eq 0) { $runsJson = '[]' }
$homeHtml = Set-Data (Join-Path $root 'templates\home.html') $runsJson
$homeOut = Join-Path $root 'index.html'
[IO.File]::WriteAllText($homeOut, $homeHtml, $utf8)
Write-Output "Home page written: $homeOut ($($runs.Count) searches)"
