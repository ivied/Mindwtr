param(
    [Parameter(Mandatory = $false)]
    [string]$InputTag
)

$ErrorActionPreference = 'Stop'

$tag = $InputTag
if (-not $tag) { $tag = $env:GITHUB_EVENT_INPUTS_TAG }
if (-not $tag) { $tag = $env:GITHUB_REF_NAME }
if (-not $tag -and $env:GITHUB_REF) {
    $tag = $env:GITHUB_REF -replace '^refs/tags/', ''
}

if (-not $tag) {
    throw "Failed to resolve release tag from input/ref."
}

$version = $tag -replace '^v', ''
if (-not $version -or $version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$') {
    throw "Invalid release tag '$tag'. Expected format like v1.2.3 or v1.2.3-rc.1."
}

if ($env:REQUIRE_STABLE_RELEASE_TAG -eq '1' -and $version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Invalid stable release tag '$tag'. Expected format like v1.2.3 without prerelease suffix."
}

"tag=$tag"
"version=$version"

