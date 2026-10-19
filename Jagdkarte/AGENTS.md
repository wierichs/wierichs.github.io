# Jagdkarte Agent Guide

## Scope

Jagdkarte is a static, installable PWA hosted from GitHub Pages. There is no build step or package-manager workflow. Keep changes within this app unless the task explicitly concerns the repository home page or another app.

## Code Map

- `index.html` is the app shell and user-facing markup.
- `app.js` wires the Leaflet map, UI state, authentication, profile workflows, markers, and location sharing.
- `data.js` loads and normalizes regional boundary data; `geometry.js` contains client-side polygon checks.
- `profile-data.js` handles profile persistence and import/export; `jwd-import.js` parses JWD files.
- `schema.sql` is the source of truth for Supabase tables, RPCs, grants, triggers, and RLS policies.
- `config.js` contains public client configuration. Never add service-role keys, tokens, passwords, or other secrets.
- `style.css` defines the responsive interface; `hilfe.html` and `hilfe.js` contain the user help.
- `sw.js` defines the PWA shell cache and offline behavior. `tests.html`, `data.test.js`, and `app.test.js` provide browser tests.

## Security And Data

- Treat client-side checks as UX only. Supabase RLS and RPC authorization must enforce every protected operation.
- Keep RLS enabled. Do not grant table access to `anon` or broad `UPDATE` privileges to authenticated users where a narrowly scoped RPC is appropriate.
- For security-definer RPCs, use an empty `search_path`, check `auth.uid()` and profile role, validate inputs, and explicitly revoke/grant execution privileges.
- Owners and Bearbeiter may manage profile markers; guests have narrower rights. Reuse the role helpers in `schema.sql` and `canEditProfile()` in `app.js` rather than inventing parallel role checks.
- Geographic coordinates are WGS84: GeoJSON uses `[longitude, latitude]`, while Leaflet APIs commonly take `[latitude, longitude]`. Keep marker destinations inside the selected profile boundary and validate them server-side as well as client-side.
- The current location-sharing flow is opt-in for invited members through the profile checkbox when Jagdmodus is active. The browser permission is separate. Do not start sharing merely because browser geolocation was previously allowed. Owner location sharing follows the Jagdmodus behavior in `app.js`.
- Marker movement must use the restricted `move_hunting_marker_to_location` RPC; do not update marker coordinates directly from the client.
- After changing `schema.sql`, tell the user to re-run it in Supabase. Browser mocks do not prove production RLS or authenticated RPC behavior.

## UI And PWA

- Keep user-facing text in German and follow existing DOM/CSS patterns. Preserve mobile usability, including narrow 320px layouts.
- Use the bundled Lucide icons. When rendering icons in dynamic Leaflet popups, render after the popup is attached/opened so Lucide replaces the placeholders with SVGs.
- When a cached shell asset changes, update the `CACHE` version in `sw.js`. When changing the app module URL, keep its query version in `index.html` in sync with the intended release.
- Keep `hilfe.html` and the relevant README instructions aligned with user-facing workflow changes. Check the implementation when docs and UI appear to disagree.

## Validation

- Open `tests.html` through a local HTTP server; module imports and service-worker behavior should not be tested through `file://`.
- Add focused cases to the existing browser fixtures in `app.test.js` or `data.test.js`. Cover role boundaries, browser-geolocation outcomes, profile switching, and offline/cache behavior when those areas change.
- Run editor diagnostics and `git diff --check` on touched files. For UI changes, inspect the rendered page at desktop and narrow mobile sizes; for marker icons, verify the actual popup SVGs and hit targets.
