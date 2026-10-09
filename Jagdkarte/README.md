# Jagdkarte

A static, installable PWA for regional German hunting-district boundaries on
OpenStreetMap. Open `https://wierichs.github.io/Jagdkarte/` after deployment.
The repository home page links to the app. No build step is required.

## Authentication Setup

1. Create a Supabase project and enable the Email authentication provider.
   Keep email confirmation enabled and allow new signups for public registration.
2. In `config.js`, set `supabaseUrl` and `supabasePublishableKey` to the project
   URL and **public publishable key** (the legacy public anon key also works).
   Never put a service-role key, secret key, or email credentials in this repo.
3. Set the Supabase Auth Site URL to `https://wierichs.github.io/Jagdkarte/`.
   Add that exact URL and `http://localhost:8087/Jagdkarte/` to the allowed
   redirect URLs. Substitute your actual deployment URL when hosting elsewhere.
4. Configure email delivery for production. Supabase's default sender has
   restrictions and rate limits. Account creation follows the project's signup
   policy; disable new signups in Supabase for an invitation-only application.
5. Open the account dialog and choose **Registrieren** for a new account or
   **Anmelden** for an existing account. Enter an email address, request the link,
   and open it on the same browser/device to verify ownership of the address.
   The SDK uses PKCE and verifies the session before enabling private profiles
   and user-created markers.

Registration is passwordless: Supabase creates and manages the account and sends
the verification link. No passwords or account database are stored by this app.
Sign-in explicitly sets `shouldCreateUser: false`; only the registration mode
sets it to `true`. Requesting a link does not grant access to owner profiles or
markers; Supabase must return a verified session first. Public boundary search
works without an account. For an already registered address, registration
can also send an access link; the UI does not claim that a new account was created.
Provider errors (including signup restrictions and email rate limits) are shown,
and pending requests disable the form to prevent duplicate submissions.

Boundary search and selection work without an account or Supabase configuration.
Only signed-in users can view owner profiles and their markers. There is no demo
account or simulated production login.

Authentication is an application-level workflow gate, not access control over
the public WFS data. Users can access the providers' public services directly.
GitHub Pages cannot enforce server-side authorization. Revierprofile and their
user-created markers are stored in Supabase and protected by the row-level
security policies in `schema.sql`.

## Owner Profiles And Markers

Run `schema.sql` once in the Supabase Dashboard SQL Editor for this project.
It creates the profile, member, invitation, and marker tables, their RLS
policies, and the RPC functions used by the app. It is additive and can be run
again safely. Rerun it after updating the app so the location table and its RLS
policies are installed. Do not disable RLS or grant access to the `anon` role.

After signing in, select a district and choose **Als Owner fuehren** to create
your profile. A district can have separate profiles for different owners; each
signed-in user has at most one profile per district. Choose a point inside the
district boundary and add a label and optional note. The owner can invite an
email address; Supabase sends a passwordless sign-in/registration link, and the
invited user receives read-only access to that profile after verifying the
same address. Owner profiles and markers remain independent from other owners'
profiles for the same district. Invitees cannot add, edit, or delete markers.
When an invitee selects a shared profile, the app asks for explicit location consent before requesting browser geolocation. Declining, or denying browser permission, leaves the public district visible in guest mode without profile data. With consent, the first fix is sent immediately and the location is refreshed every 30 seconds only while it is inside the selected polygon. The owner and invited members of that profile can see one another; their maps also refresh every 30 seconds. Entries older than 90 seconds are not displayed. Leaving the polygon, changing profiles, or
signing out removes the user's location row when the app can reach Supabase.

Available marker types are defined in `marker-types.json`. Each type has a
stable lowercase `id`, display `label`, local SVG `iconUrl`, and Leaflet icon
size/anchor coordinates. Add its SVG under `markers/` and list both the JSON
entry and SVG path in the `SHELL` array in `sw.js`; then increment the shell
cache version. Markers store the type ID, not embedded SVG markup. Unknown IDs
render with the configured fallback type.

The invitation uses Supabase's standard OTP email template. Configure the Auth
Site URL and allowed redirects for the deployed app and local preview, and use a
production email provider before inviting users. A user already signed into a
different account should open the invitation link in a separate browser profile
or sign out first.

## Data Coverage

Choose a region to load its district data; no regional dataset is fetched before
the first selection. The app loads only the selected region, and changing the
region cancels an in-flight request for the previous one. Bielefeld,
Nordrhein-Westfalen, is one available source; its live WFS returned 63 polygon
features during browser verification. Search matches names, numbers, and scalar
attributes, including EJB/GJB codes. Selecting a result highlights and fits its
polygon; the boundary can be toggled or exported as GeoJSON with source and
license information.

**Rhein-Kreis Neuss** is also available as a local, searchable snapshot of
140 district polygons, retrieved on 2026-10-08. Its public portal provides WMS
GetFeatureInfo in JSON, but no advertised hunting-district WFS collection. A
browser request from the app origin was verified on 2026-10-09. GetFeatureInfo
returns only features around the requested map pixel, not a complete collection;
large query buffers can fail. The snapshot therefore avoids repeating dozens of
sampling requests for every user and does not pretend to be a live feed. The app
shows its retrieval date, district name, and area in hectares. Its source terms
apply DL-DE-Zero-2.0 to this layer:
https://maps.rhein-kreis-neuss.de/rknportale/Nutzungsbestimmungen.html

The source is `https://maps.rhein-kreis-neuss.de/services/RKN_Jagdbezirke/wms`,
layer `jagdbezirke`, with `jagdbezirk` and `hektar` attributes. Matching IDs from
5x5 and 9x9 county-wide feature-info sampling grids provide a coverage consistency
check, not an authoritative completeness guarantee from the publisher.

Four additional live regions use KRZN OGC API Features GeoJSON collections:
Kreis Viersen (138 features), Kreis Kleve (295), Krefeld (24), and Kreis Wesel
(288). The endpoints were checked on 2026-10-09 for browser CORS, complete
feature counts, unique IDs, polygon geometry, and CRS84 longitude/latitude
coordinates. Their catalogue records identify the license as DL-DE-Zero-2.0.
The configured `limit=500` currently covers every feature in each collection;
the counts can change as publishers update their data. These checks confirm the
published response, not legal completeness or current field conditions.

**Trier, Rheinland-Pfalz** adds 28 live Jagdbezirk polygons via the Geoportal
RLP OGC API Features collection. The items endpoint supports browser access and
returns all 28 features with `limit=500`; it nevertheless emits an extra `next`
link after the complete result. The loader stops when `numberMatched` is
reached. Feature IDs are in `ID1`; display names use `Kurzname` and `Jagdbezirk`.
The catalogue metadata specifies DL-DE-BY-2.0 and attribution to Stadt Trier:
https://www.geoportal.rlp.de/mapbender/php/mod_showMetadata.php?languageCode=de&resource=layer&layout=tabs&id=81585

Refresh from the repository root with PowerShell:

```powershell
./Jagdkarte/refresh-neuss.ps1
```

The script validates feature IDs, polygon geometry, geographic coordinates,
feature limits, and agreement between the two grids before replacing
`neuss.geojson`. It makes 106 sequential, read-only requests; refresh only when
needed. On a failed check, the existing snapshot is preserved. After refreshing,
update `snapshotDate` in `config.js` and increment the cache version in `sw.js`.
The generated GeoJSON retains retrieval time, attribution, source, and terms.

- Dataset: https://www.bielefeld01.de/mdOLKD/Daten/jagdreviere_pl?FORMAT=HTML_Daten
- WFS: https://bielefeld01.de/mdOLKD/WFS/jagdreviere/01
- Layer: `ms:jagdreviere_pl`
- Format: `application/json; subtype=geojson`
- Fields: `revierda_1` (name), `revierdate` (type), `id` (number)
- The dataset page explicitly lists CC BY 4.0 with attribution to Stadt
  Bielefeld, Amt fuer Geoinformation und Kataster. The app retains that credit.
  **Licensing caveat:** the WFS capabilities document has conflicting restrictive
  boilerplate. Confirm the dataset-specific license with the publisher before
  production redistribution, especially commercial use.

German hunting data is regional and inconsistently published. No verified,
complete nationwide open hunting-boundary service was found during this work.
Unconfigured regions are not implicitly covered, and administrative boundaries
are never substituted for hunting boundaries.

To add a region, append a source to the `sources` array in `config.js`, specifying
`id`, `label`, `type`, HTTPS `url`, `nameFields`, `attribution`, `license`,
`licenseUrl`, and `metadataUrl`. Set optional `idFields` when stable feature IDs
are stored in source-specific properties instead of GeoJSON `id` fields. Use
`type: 'wfs'` with `typeName` and
`outputFormat` for WFS 2.0, `type: 'ogcapi'` for an OGC API Features items URL,
or `type: 'snapshot'` for a complete static GeoJSON FeatureCollection. OGC API
pagination follows same-origin `next` links and rejects a final page whose
`numberMatched` exceeds the received feature count. Verify browser CORS, the
license, exact property names, stable feature IDs, polygon geometry, and
longitude/latitude coordinates before enabling a source. WFS and OGC API
requests have a 20,000-feature safety limit; all source loads have a 30-second
timeout.

The catalogue WFS endpoint for Kreis Wesel advertises GeoJSON but failed browser
CORS verification and is not used. A separate KRZN OGC API Features collection
for the same district set passed the browser and geometry checks above and is
the configured source. Do not use an anonymous third-party CORS proxy for
authentication or data access.

Displayed borders are informational, not legally authoritative or permission
to hunt. Availability, accuracy, and currency remain the provider's responsibility.

## National Service Harvesting

`harvest-govdata.ps1` queries the official GovData CKAN API for Jagdbezirk,
Jagdrevier, Jagdkataster, and Eigenjagd terms. It follows result pagination,
deduplicates catalog packages, and emits one review candidate per matching
WFS, OGC API Features, WMS, ArcGIS REST, or downloadable resource. The default
output is `govdata-candidates.json`. Candidates retain source metadata,
resource-specific license, update date, detected service type, feature type,
CRS hints, and any AGS codes found in catalog metadata. Missing AGS or license
information is left empty rather than inferred. `is_open_data` copies GovData's
dataset-level flag; it does not replace review of each resource's license.

Run the metadata scan from the repository root:

```powershell
./Jagdkarte/harvest-govdata.ps1
```

To create a Supabase Table Editor import file with ISO-formatted timestamps:

```powershell
./Jagdkarte/harvest-govdata.ps1 -CsvOutputPath "$env:TEMP/govdata-candidates.csv"
```

This is a discovery inventory, not an automatic publication path. Review
license, ownership, service health, feature type, geometry, CRS, and geographic
coverage before marking a row verified or enabling a source in the map. WMS
records are retained as references but do not provide downloadable geometry.
The scanner does not crawl arbitrary websites, download boundaries, or alter
the public map's source list.

The initial run on 2026-10-09 found 29 unique packages and 59 resources:
26 WFS, 8 OGC API Features, 14 WMS, and 11 downloads. The resources remain
private `candidate` rows in Supabase; map activation is managed separately in
`config.js`. Four reviewed KRZN collections are now configured as map sources.
The app's published boundary coverage is Bielefeld, the Rhein-Kreis Neuss
snapshot, and the four KRZN regions listed above.

`harvesting-schema.sql` creates the private Supabase review table. The optional
`-Upload` switch upserts candidates only when a trusted process provides
`JAGDKARTE_SUPABASE_URL` and `JAGDKARTE_SUPABASE_SERVICE_ROLE_KEY` environment
variables. Never put that key in the repository or use the public browser key
for writes. The table is inaccessible to `anon` and `authenticated`; uploaded
records remain `candidate` until manually reviewed.

GovData is the first implemented catalog adapter, not a complete national
harvest. GDI-DE/INSPIRE, state portals, and additional catalog APIs still need
separate adapters. Keep source CRSs in the inventory: EPSG:25832 is a local UTM
zone, not a suitable single projection for all of Germany.

## PWA And Hosting

Serve the repository root over HTTPS or a localhost HTTP server; opening the
HTML as a file will not support ES modules or service workers. The running local
preview is `http://localhost:8087/Jagdkarte/`. The app works on GitHub Pages and
uses relative URLs, a scoped service worker, and 192/512px installation icons.

The app shell and bundled libraries are cached offline. Authentication, live
district searches, and background maps require a connection. OSM tiles are not
bulk downloaded or service-worker cached, respecting the standard tile usage
policy: https://operations.osmfoundation.org/policies/tiles/ . For high traffic,
use a suitable tile provider or self-hosted tiles. Offline authentication is not
simulated. Loaded polygons remain visible in memory until reload or logout.

For a new deployment, increment the cache version in `sw.js` whenever a cached
asset changes, including authentication configuration. Close existing app tabs
and reopen after the new worker activates. Other repository apps' caches are
not modified.

Dependencies are bundled: Supabase JS 2.49.8, Lucide 0.468.0, and Leaflet 1.9.3
under `vendor/leaflet/`. Its license and runtime images are included locally, so
the app does not depend on files from another project directory.

The separate map location button still requests a one-time local position and
does not store it. Shared-profile tracking requires the consent flow above and
stores one current position per user/profile in Supabase. If the app closes or
loses connectivity before it can remove that row, the owner stops seeing it
after 90 seconds, but the row remains until the user next selects/leaves that
profile or the profile is deleted. Supabase stores its session in browser
storage and the profile, invitation, marker, and consented location data in the
project database. Supabase, OSM, and the WFS provider receive the requests
needed for their services. Review your authentication provider's privacy and
retention settings for production.

## Verification

The configured Jagdkarte project responds to the Auth health check. Its public
Auth settings confirm that Email is enabled, signups are allowed, and email
confirmation is required. The Auth Site URL and allowlist are verified as
`https://wierichs.github.io/Jagdkarte/` and
`http://localhost:8087/Jagdkarte/`. A real email-delivery and PKCE round-trip
still needs testing with a user's mailbox.

Browser checks cover the live map, GeoJSON filtering, malformed-response rejection,
WFS pagination parameters, app-shell caching, authenticated search with a mocked
Supabase session service and live WFS data, district selection, boundary visibility,
export, logout, desktop/mobile layout, and offline shell reload. The production
app never uses the test session or test configuration.

The focused data-loader tests are in `tests.html` and `data.test.js`. Serve the
repository root locally, then open `http://localhost:8087/Jagdkarte/tests.html`.
They cover snapshots, WFS pagination, OGC API `next` links, and detection of an
incomplete OGC API response.

The owner-profile and marker UI was checked at desktop and mobile sizes. The
schema is now applied to the live project: SQL verification confirmed all four
tables have RLS enabled, six policies and five RPC functions exist, and the
`type_id` marker column is present. An anonymous REST read was rejected with
HTTP 401. A real owner-profile write and two-account invitation round-trip still
need testing with signed-in users and working email delivery.