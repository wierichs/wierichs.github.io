[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'neuss.geojson')
)

$ErrorActionPreference = 'Stop'
$serviceUrl = 'https://maps.rhein-kreis-neuss.de/services/RKN_Jagdbezirke/wms'
$termsUrl = 'https://maps.rhein-kreis-neuss.de/rknportale/Nutzungsbestimmungen.html'
$limit = 10000
$mapWidth = 2619
$mapHeight = 1770
$refinementHalfWidth = 0.10
$refinementHalfHeight = 0.042
$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$featuresById = @{}
$previousIds = $null

foreach ($gridSize in @(5, 9)) {
    $passIds = @{}
    for ($row = 0; $row -lt $gridSize; $row += 1) {
     for ($column = 0; $column -lt $gridSize; $column += 1) {
    $parameters = [ordered]@{
        SERVICE = 'WMS'
        VERSION = '1.1.1'
        REQUEST = 'GetFeatureInfo'
        LAYERS = 'jagdbezirke'
        QUERY_LAYERS = 'jagdbezirke'
        STYLES = ''
        FORMAT = 'image/png'
        SRS = 'EPSG:4326'
        BBOX = '6.42,51.00,6.90,51.35'
        WIDTH = '200'
        HEIGHT = '200'
        X = [string][int][Math]::Round($column * 199 / ($gridSize - 1))
        Y = [string][int][Math]::Round($row * 199 / ($gridSize - 1))
        buffer = '400'
        INFO_FORMAT = 'application/json'
        FEATURE_COUNT = [string]$limit
    }
    $query = ($parameters.GetEnumerator() | ForEach-Object {
        '{0}={1}' -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString($_.Value)
    }) -join '&'
    $response = Invoke-WebRequest -Uri ($serviceUrl + '?' + $query) -TimeoutSec 60
    $content = if ($response.Content -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($response.Content)
    } else {
        $response.Content
    }
    $collection = $content | ConvertFrom-Json
    if ($collection.type -ne 'FeatureCollection') {
        throw 'The hunting service returned no GeoJSON collection; the existing snapshot was not changed.'
    }
    if ($collection.features.Count -ge $limit) {
        throw 'The query reached its feature limit; refusing to write a potentially truncated snapshot.'
    }
    foreach ($feature in $collection.features) {
        if (-not $feature.id -or -not $feature.properties.jagdbezirk -or
            $feature.geometry.type -notin @('Polygon', 'MultiPolygon')) {
            throw 'A feature is missing its ID, district name, or polygon geometry.'
        }
        $coordinate = if ($feature.geometry.type -eq 'MultiPolygon') {
            $feature.geometry.coordinates[0][0][0]
        } else {
            $feature.geometry.coordinates[0][0]
        }
        if ($coordinate[0] -lt 6 -or $coordinate[0] -gt 7.5 -or
            $coordinate[1] -lt 50.5 -or $coordinate[1] -gt 51.8) {
            throw 'Coordinates are not longitude/latitude in the Rhein-Kreis Neuss area.'
        }
        $passIds[[string]$feature.id] = $true
        $featuresById[[string]$feature.id] = $feature
    }
   }
  }
    $ids = @($passIds.Keys | Sort-Object)
    if ($ids.Count -eq 0) {
        throw 'No district polygons were found; the existing snapshot was not changed.'
    }
    if ($null -ne $previousIds -and @(Compare-Object $previousIds $ids).Count) {
        throw 'The denser sampling grid returned different feature IDs; coverage needs investigation before refreshing.'
    }
    $previousIds = $ids
    Write-Output "$gridSize x $gridSize grid: $($ids.Count) district polygons verified."
}

foreach ($featureId in @($featuresById.Keys)) {
    $coarseFeature = $featuresById[$featureId]
    $coordinate = if ($coarseFeature.geometry.type -eq 'MultiPolygon') {
        $coarseFeature.geometry.coordinates[0][0][0]
    } else {
        $coarseFeature.geometry.coordinates[0][0]
    }
    $longitude = [double]$coordinate[0]
    $latitude = [double]$coordinate[1]
    $bbox = @(
        ($longitude - $refinementHalfWidth).ToString('0.00000000', $invariantCulture)
        ($latitude - $refinementHalfHeight).ToString('0.00000000', $invariantCulture)
        ($longitude + $refinementHalfWidth).ToString('0.00000000', $invariantCulture)
        ($latitude + $refinementHalfHeight).ToString('0.00000000', $invariantCulture)
    ) -join ','
    $parameters = [ordered]@{
        SERVICE = 'WMS'
        VERSION = '1.1.1'
        REQUEST = 'GetFeatureInfo'
        LAYERS = 'jagdbezirke'
        QUERY_LAYERS = 'jagdbezirke'
        STYLES = ''
        FORMAT = 'image/png'
        SRS = 'EPSG:4326'
        BBOX = $bbox
        WIDTH = [string]$mapWidth
        HEIGHT = [string]$mapHeight
        X = [string][int][Math]::Floor($mapWidth / 2)
        Y = [string][int][Math]::Floor($mapHeight / 2)
        buffer = '400'
        INFO_FORMAT = 'application/json'
        FEATURE_COUNT = [string]$limit
    }
    $query = ($parameters.GetEnumerator() | ForEach-Object {
        '{0}={1}' -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString($_.Value)
    }) -join '&'
    $response = Invoke-WebRequest -Uri ($serviceUrl + '?' + $query) -TimeoutSec 60
    $content = if ($response.Content -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($response.Content)
    } else {
        $response.Content
    }
    $collection = $content | ConvertFrom-Json
    if ($collection.type -ne 'FeatureCollection' -or $collection.features.Count -ge $limit) {
        throw "The detailed query for $featureId returned an invalid or truncated feature collection."
    }
    $refinedFeature = $collection.features | Where-Object { [string]$_.id -eq [string]$featureId } | Select-Object -First 1
    if (-not $refinedFeature -or $refinedFeature.geometry.type -notin @('Polygon', 'MultiPolygon')) {
        throw "The detailed query did not return polygon $featureId; the existing snapshot was not changed."
    }
    $featuresById[$featureId] = $refinedFeature
}

$snapshot = [ordered]@{
    type = 'FeatureCollection'
    name = 'Rhein-Kreis Neuss Jagdbezirke'
    source = $serviceUrl
    layer = 'jagdbezirke'
    attribution = 'Rhein-Kreis Neuss, Kataster- und Vermessungsamt'
    license = 'Datenlizenz Deutschland - Zero - Version 2.0'
    licenseUrl = 'https://www.govdata.de/dl-de/zero-2-0'
    termsUrl = $termsUrl
    retrievedAt = [DateTime]::UtcNow.ToString('o')
    coverage = '5x5 and 9x9 WMS grids returned matching IDs; each polygon was then queried in a portal-scale window. Publisher completeness is not guaranteed.'
    features = @($featuresById.Values | Sort-Object { $_.properties.jagdbezirk }, { $_.id })
}
$json = $snapshot | ConvertTo-Json -Depth 100
$temporaryPath = $OutputPath + '.tmp'
try {
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force
} finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
}
Write-Output "Saved $($featuresById.Count) district polygons to $OutputPath."