# Contributing to BimRadar

PRs welcome! A few things that make this repo unusual — and easy:

## Running it locally

No build step, no keys, no dependencies:

```bash
npx serve .        # or any static file server, then open the printed URL
```

You're now running the real app against live Graz data (the client falls back
to querying HAFAS directly when the `/api/vehicles.json` feed isn't there).

## The shape of the code

- **The whole app is one file, `index.html`** (~4.5k lines, inline JS/CSS).
  Keep PRs small and focused — two large PRs against one file will conflict.
- `tools/feed_poller.js` — the production feed proxy (zero npm deps).
- `tools/gen_icons.js` — regenerates the PWA icons (zero npm deps).
- Everything is JavaScript. Please keep it that way, and keep tools free of
  npm dependencies.

## Deploys are automatic

**A merge to `main` goes live on [bimradar.at](https://bimradar.at) within
seconds** (a webhook on the server pulls, deploys, health-checks). Notes:

- **Don't bump the service-worker cache version** in `sw.js` — the deploy
  stamps it with the commit sha automatically.
- If your change touches `tools/feed_poller.js`, the feed service is
  restarted automatically as part of the deploy.

## Before you open a PR

- Test in the browser (light + dark, and the 3D toggle if you touched it).
- `node --check` any JS file you edited.
- One topic per PR.

## Found a bug instead?

[Open an issue](https://github.com/EpicHammer/bimradar/issues) — a screenshot
and the line name (e.g. "tram 4 near Hauptplatz") is usually enough.
