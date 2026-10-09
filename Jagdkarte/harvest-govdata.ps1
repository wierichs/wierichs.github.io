[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'govdata-candidates.json'),
    [string]$CsvOutputPath,
    [ValidateRange(1, 100)]
    [int]$RowsPerPage = 100,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 45,
    [switch]$Upload
)

$ErrorActionPreference = 'Stop'
$apiUrl = 'https://www.govdata.de/ckan/api/3/action/package_search'
$searchTerms = @(
    'Jagdbezirk',
    'Jagdbezirke',
    'Jagdrevier',
    'Jagdreviere',
    'Jagdkataster',
    'Eigenjagdbezirk',
    'gemeinschaftlicher Jagdbezirk'
)
$packagesById = @{}
$agsToState = @{
    '01' = 'Schleswig-Holstein'
    '02' = 'Hamburg'
    '03' = 'Niedersachsen'
    '04' = 'Bremen'
    '05' = 'Nordrhein-Westfalen'
    '06' = 'Hessen'
    '07' = 'Rheinland-Pfalz'
    '08' = 'Baden-Wuerttemberg'
    '09' = 'Bayern'
    '10' = 'Saarland'
    '11' = 'Berlin'
    '12' = 'Brandenburg'
    '13' = 'Mecklenburg-Vorpommern'
    '14' = 'Sachsen'
    '15' = 'Sachsen-Anhalt'
    '16' = 'Thueringen'
}

function Get-ExtraValue {
    param(
        [object]$Record,
        [string]$Key
    )

    $matchingExtra = @($Record.extras | Where-Object { $_.key -eq $Key } | Select-Object -First 1)
    if ($matchingExtra.Count -eq 0) { return $null }
    return $matchingExtra[0].value
}

function Get-ServiceType {
    param(
        [string]$Url,
        [string]$Name,
        [string]$Description,
        [string]$Format
    )

    $searchText = "$Name $Description $Format $Url"
    if ($Url -match '(?i)/rest/services/|arcgis\.com/.+(?:Feature|Map)Server') { return 'ArcGIS REST' }
    if ($searchText -match '(?i)OGC\s*API|\bOAF\b|ISO\s*19168|/collections/|/spatial-objects/') { return 'OGC API Features' }
    if ($searchText -match '(?i)\bWFS\b|WFS_SRVC|SERVICE=WFS') { return 'WFS' }
    if ($searchText -match '(?i)\bWMS\b|WMS_SRVC|SERVICE=WMS') { return 'WMS' }
    if ($searchText -match '(?i)GeoJSON|GeoPackage|Shapefile|SHAPE-ZIP|\.geojson(?:$|[?#])|\.gpkg(?:$|[?#])|\.zip(?:$|[?#])') {
        return 'Download'
    }
    return $null
}

function Get-FeatureType {
    param([string]$Url, [string]$Description)

    if ($Url -match '(?i)(?:TYPENAMES?|FEATURETYPE_ID)=([^&]+)') {
        return [Uri]::UnescapeDataString($Matches[1])
    }
    if ($Description -match '(?i)(?:Objektart|Feature Type)\s*:\s*([^\r\n<]+)') {
        return $Matches[1].Trim()
    }
    return $null
}

function Get-Crs {
    param([string]$Url, [string]$Description)

    if ($Url -match '(?i)(?:SRSNAME|CRS)=([^&]+)') {
        return [Uri]::UnescapeDataString($Matches[1])
    }
    if ($Description -match '(?i)EPSG\s*:\s*\d+') {
        return $Matches[0].Replace(' ', '')
    }
    return $null
}

function Get-AgsCodes {
    param([object]$Package)

    $codes = @()
    $politicalGeocoding = Get-ExtraValue -Record $Package -Key 'politicalGeocodingURI'
    if ($politicalGeocoding) {
        try { $geocodingUris = @($politicalGeocoding | ConvertFrom-Json) }
        catch { $geocodingUris = @([string]$politicalGeocoding) }
        foreach ($geocodingUri in $geocodingUris) {
            if ($geocodingUri -match '/(?:municipalityKey|regionalKey)/(\d{8})\d*(?:$|/)') {
                $codes += $Matches[1]
            } elseif ($geocodingUri -match '/districtKey/(\d{5})(?:$|/)') {
                $codes += $Matches[1]
            }
        }
    }
    foreach ($tag in $Package.tags) {
        if ([string]$tag.name -match '^(\d{5}|\d{8})$') { $codes += $Matches[1] }
    }
    return @($codes | Sort-Object -Unique)
}

$requestCount = 0
foreach ($searchTerm in $searchTerms) {
    $start = 0
    do {
        $query = 'q={0}&rows={1}&start={2}' -f [Uri]::EscapeDataString($searchTerm), $RowsPerPage, $start
        $response = Invoke-RestMethod -Uri "$apiUrl`?$query" -TimeoutSec $TimeoutSeconds -UserAgent 'Jagdkarte-service-catalog/1.0'
        $requestCount += 1
        if (-not $response.success) { throw "GovData search failed for '$searchTerm'." }
        $batch = @($response.result.results)
        foreach ($package in $batch) {
            if (-not $packagesById.ContainsKey([string]$package.id)) {
                $packagesById[[string]$package.id] = $package
            }
        }
        if ($batch.Count -eq 0) { break }
        $start += $batch.Count
    } while ($start -lt [int]$response.result.count)
}

$candidates = @()
foreach ($package in $packagesById.Values) {
    $searchableMetadata = @(
        $package.title
        $package.notes
        $package.tags | ForEach-Object { $_.display_name }
        $package.resources | ForEach-Object { $_.name; $_.description }
    ) -join ' '
    $matchedTerms = @($searchTerms | Where-Object {
        $searchableMetadata.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($matchedTerms.Count -eq 0) { continue }

    $agsCodes = @(Get-AgsCodes -Package $package)
    $ags = if ($agsCodes.Count -eq 1) { $agsCodes[0] } else { $null }
    $state = $null
    if ($agsCodes.Count -gt 0 -and $agsToState.ContainsKey($agsCodes[0].Substring(0, 2))) {
        $state = $agsToState[$agsCodes[0].Substring(0, 2)]
    }
    $catalogueUrl = Get-ExtraValue -Record $package -Key 'uri'
    if (-not $catalogueUrl) { $catalogueUrl = "https://www.govdata.de/dataset/$($package.name)" }

    foreach ($resource in $package.resources) {
        $serviceUrl = if ($resource.url) { [string]$resource.url } else { [string]$resource.access_url }
        if (-not $serviceUrl) { continue }
        $serviceType = Get-ServiceType -Url $serviceUrl -Name ([string]$resource.name) `
            -Description ([string]$resource.description) -Format ([string]$resource.format)
        if (-not $serviceType) { continue }

        $lastUpdateValue = if ($resource.modified) { $resource.modified } else { $package.metadata_modified }
        $lastUpdate = $null
        if ($lastUpdateValue) {
            try { $lastUpdate = [DateTimeOffset]::Parse([string]$lastUpdateValue).ToString('o') }
            catch { $lastUpdate = $null }
        }
        $metadata = [ordered]@{
            title = $package.title
            description = $package.notes
            publisher = $package.organization.title
            publisherName = Get-ExtraValue -Record $package -Key 'publisher_name'
            tags = @($package.tags | ForEach-Object { $_.display_name })
            matchedSearchTerms = $matchedTerms
            resourceName = $resource.name
            resourceDescription = $resource.description
            resourceFormat = $resource.format
            resourceModified = $resource.modified
            catalogueRecordId = $package.id
            resourceId = $resource.id
        }
        $candidates += [pscustomobject][ordered]@{
            catalogue_source = 'GovData CKAN'
            catalogue_record_id = [string]$package.id
            resource_id = [string]$resource.id
            ags = $ags
            ags_codes = $agsCodes
            bundesland = $state
            landkreis = $null
            diensttyp = $serviceType
            layername = if ($resource.name) { [string]$resource.name } else { [string]$package.title }
            service_url = $serviceUrl
            feature_type = Get-FeatureType -Url $serviceUrl -Description ([string]$resource.description)
            geometry_type = $null
            crs = Get-Crs -Url $serviceUrl -Description ([string]$resource.description)
            licence = if ($resource.license) { [string]$resource.license } else { [string]$package.license_title }
            last_update = $lastUpdate
            catalogue_url = [string]$catalogueUrl
            is_open_data = [bool]$package.isopen
            discovered_at = [DateTimeOffset]::UtcNow.ToString('o')
            metadata = $metadata
        }
    }
}

$harvest = [ordered]@{
    catalogue = 'GovData CKAN API'
    catalogueUrl = 'https://www.govdata.de/'
    harvestedAt = [DateTimeOffset]::UtcNow.ToString('o')
    searchTerms = $searchTerms
    apiRequests = $requestCount
    packageCount = $packagesById.Count
    candidateResourceCount = $candidates.Count
    reviewRequired = $true
    candidates = @($candidates | Sort-Object bundesland, ags, layername, service_url)
}
$json = $harvest | ConvertTo-Json -Depth 30
$temporaryPath = $OutputPath + '.tmp'
try {
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $OutputPath -Force
} finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
}

Write-Output "GovData: $($packagesById.Count) unique packages, $($candidates.Count) candidate resources from $requestCount API requests."
Write-Output "Saved review candidates to $OutputPath. Candidates are not enabled in the public map."

if ($CsvOutputPath) {
    $csvRows = foreach ($candidate in $candidates) {
        $codes = @($candidate.ags_codes)
        $arrayValue = if ($codes.Count) { '{' + ($codes -join ',') + '}' } else { $null }
        $lastUpdate = $null
        if ($candidate.last_update) {
            $lastUpdate = [DateTimeOffset]::Parse(
                [string]$candidate.last_update,
                [Globalization.CultureInfo]::InvariantCulture
            ).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:sszzz')
        }
        $discoveredAt = [DateTimeOffset]::Parse(
            [string]$candidate.discovered_at,
            [Globalization.CultureInfo]::InvariantCulture
        ).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:sszzz')
        [pscustomobject]@{
            ags = $candidate.ags
            ags_codes = $arrayValue
            bundesland = $candidate.bundesland
            landkreis = $candidate.landkreis
            diensttyp = $candidate.diensttyp
            layername = $candidate.layername
            service_url = $candidate.service_url
            feature_type = $candidate.feature_type
            geometry_type = $candidate.geometry_type
            crs = $candidate.crs
            licence = $candidate.licence
            last_update = $lastUpdate
            catalogue_source = $candidate.catalogue_source
            catalogue_record_id = $candidate.catalogue_record_id
            resource_id = $candidate.resource_id
            catalogue_url = $candidate.catalogue_url
            is_open_data = $candidate.is_open_data
            discovered_at = $discoveredAt
            metadata = ConvertTo-Json -InputObject $candidate.metadata -Depth 30 -Compress
        }
    }
    $csvTemporaryPath = $CsvOutputPath + '.tmp'
    try {
        $csvRows | Export-Csv -LiteralPath $csvTemporaryPath -NoTypeInformation -Encoding utf8
        Move-Item -LiteralPath $csvTemporaryPath -Destination $CsvOutputPath -Force
    } finally {
        if (Test-Path -LiteralPath $csvTemporaryPath) { Remove-Item -LiteralPath $csvTemporaryPath }
    }
    Write-Output "Saved Supabase import CSV to $CsvOutputPath."
}

if ($Upload) {
    $supabaseUrl = [Environment]::GetEnvironmentVariable('JAGDKARTE_SUPABASE_URL')
    $serviceRoleKey = [Environment]::GetEnvironmentVariable('JAGDKARTE_SUPABASE_SERVICE_ROLE_KEY')
    if (-not $supabaseUrl -or -not $serviceRoleKey) {
        throw 'Upload requires JAGDKARTE_SUPABASE_URL and JAGDKARTE_SUPABASE_SERVICE_ROLE_KEY environment variables.'
    }
    $headers = @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
        Prefer = 'resolution=merge-duplicates,return=minimal'
    }
    $uploadUrl = "$($supabaseUrl.TrimEnd('/'))/rest/v1/hunting_district_services?on_conflict=catalogue_source,catalogue_record_id,resource_id"
    for ($offset = 0; $offset -lt $candidates.Count; $offset += 100) {
        $end = [Math]::Min($offset + 99, $candidates.Count - 1)
        $rows = @($candidates[$offset..$end] | ForEach-Object {
            [pscustomobject]@{
                catalogue_source = $_.catalogue_source
                catalogue_record_id = $_.catalogue_record_id
                resource_id = $_.resource_id
                ags = $_.ags
                ags_codes = $_.ags_codes
                bundesland = $_.bundesland
                landkreis = $_.landkreis
                diensttyp = $_.diensttyp
                layername = $_.layername
                service_url = $_.service_url
                feature_type = $_.feature_type
                geometry_type = $_.geometry_type
                crs = $_.crs
                licence = $_.licence
                last_update = $_.last_update
                catalogue_url = $_.catalogue_url
                is_open_data = $_.is_open_data
                discovered_at = $_.discovered_at
                metadata = $_.metadata
            }
        })
        $body = ConvertTo-Json -InputObject $rows -Depth 30 -Compress
        Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers `
            -ContentType 'application/json' -Body $body -TimeoutSec $TimeoutSeconds | Out-Null
    }
    Write-Output "Uploaded $($candidates.Count) resources to Supabase; existing review_status values were preserved."
}