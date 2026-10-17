# BimRadar — notes for Claude

Live map of Graz trams and buses, live at https://bimradar.at. See CONTRIBUTING.md
for the code layout; the essentials are repeated here.

## Shipping

- **Never push to `main`.** A push to `main` deploys to bimradar.at within
  seconds (GitHub webhook → `tools/deploy.js` on the server). Work on a branch,
  push it, open a PR. The owner's account can bypass branch protection, so this
  rule is the only guard against an accidental deploy.
- **Merge your own PR yourself once CI is green; don't ask first** (the
  owner's standing rule, 2026-10-18). Wait for the `test` check, then
  `gh pr merge <n> --squash --admin --delete-branch`. In cloud sessions
  `gh pr` is blocked; use
  `gh api -X PUT repos/EpicHammer/bimradar/pulls/<n>/merge -f merge_method=squash`.
  Then confirm it's live: `curl -s https://bimradar.at/sw.js | grep bimradar-`
  shows the merge commit's short sha. Tell the owner what went live, with the
  PR link.
  - Never merge a red PR: fix it on the branch first.
  - PRs from other contributors are merged only when the owner says so.
  - Admin bypass needs the owner's GitHub login (local `gh`, or `/web-setup`
    in the cloud). As the Claude GitHub App the merge is blocked by the
    required review; then leave the PR for the owner.
- Branch names: `feat/…`, `fix/…`, `perf/…`, `docs/…`.
- One topic per PR. The app is one ~5.6k-line `index.html`; two large PRs
  against it will conflict.
- Commit only the paths you changed (`git add <path>`, never `git add -A`).

## Checks before a PR

```bash
node tools/test.js
node --check tools/feed_poller.js && node --check tools/push_server.js && node --check tools/deploy.js && node --check tools/deploy_hook.js
```

CI runs the same (`.github/workflows/ci.yml`); the deploy also refuses to go
live if `tools/test.js` fails. When you add logic, add a check to
`tools/test.js`: it lifts functions out of `index.html` by name and runs them
in a `vm` context.

## Rules of the code

- Plain JavaScript only, no build step, no npm dependencies (tools included).
- Don't bump the service-worker cache version in `sw.js`; the deploy stamps it
  with the commit sha.
- Only the files in `tools/app_files.json` are deployed.
- UI text is English in the source; German goes through `i18()`, keyed by the
  English string, with the translation in the `DE` dict. New UI strings need a
  `DE` entry.
- Run locally with `npx serve .`. Without `/api/vehicles.json` the client
  queries HAFAS directly.

## Product decisions (don't undo)

- The map bearing is locked north. No rotation or compass.
- Phones are always 3D. The 3D toggle is desktop-only.
- No vehicle filter chips ("too much clutter").
- No Schlossberg terrain or Schloßbergbahn. Removed on purpose; the code is in
  git history.
- Landmarks are built only from real OSM data (Overpass, or Nominatim as a
  fallback). Never invent details. Prefer muted, subtle styling to showy.
- CARTO feature ids are not reliable OSM ids: one id can hide a whole group of
  buildings. Make landmark models enclose CARTO's buildings rather than hiding
  them by id.

## Cloud sessions

- There is no browser pane. Visual changes (3D, landmarks, mobile layout) need
  a human look: say so in the PR, with a deep link to check
  (`https://bimradar.at/?lat=47.07&lon=15.44&z=16`, once deployed).
- Hosts the app and its tools reach must be on the environment's network
  allowlist: verkehrsauskunft.verbundlinie.at (HAFAS),
  *.basemaps.cartocdn.com, routing.openstreetmap.de, photon.komoot.io,
  bimradar.at, overpass-api.de, nominatim.openstreetmap.org,
  api.opentopodata.org.
- There is no SSH to the server. Server changes (systemd, nginx, push server)
  are done from the owner's PC.
