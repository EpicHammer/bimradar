# BimRadar

Live map of Graz trams (*Bims*) and buses — watch them move in real time, browse
stop departures, plan a trip, and explore a hand-modeled 3D Graz. One HTML file,
no build step, no keys; plus an optional 40-line feed proxy.

**Live:** <https://bimradar.at>

## What it does

- **Live vehicles.** Every Bim, bus and train in the current map view, drawn as
  top-down silhouettes rotated to their heading and gliding smoothly between
  updates (the feed refreshes every 7 s; positions are tweened in between).
- **Real line colours.** Trams wear the official Graz line colours — cyan 1,
  light-green 3, gold 4, dark-blue 5, dark-green 6/16, red 7/17, purple 23 —
  sampled from the Verbund Linie network plan.
- **Five categories, colour-coded:** Bims, Stadtbus, RegioBus, **Nachtlinien**
  (violet — because at 2 a.m. that's what you care about), and trains.
- **Every stop**, as *Haltestelle* "H" badges; red where a tram calls, grey for
  bus-only. Tap one for a live departure board with real-time times in green.
- **Trip planner** with autocomplete, "use my location", and map-tap picking.
  Results show the chain of vehicles to take (`[S3] › 🚶 › [4]`), and the chosen
  journey draws on the map.
- Light/dark, and a proper bottom sheet on mobile with drag-to-peek.
- **3D mode.** Tilted camera with extruded buildings (real heights from the CARTO
  tiles), vehicles as grounded top-down models with fake extrusion — and **15
  hand-modeled Graz landmarks** built procedurally in three.js from their real
  OSM footprints: Uhrturm, Glockenturm, Murinsel, Kunsthaus, Herz-Jesu-Kirche,
  Mausoleum, Dom, Burg, Oper and more. **Tap a landmark for its story.**
  Vehicles passing behind buildings fade to ghosts (per-vehicle line-of-sight
  occlusion — DOM markers can't be depth-tested, so it's done geometrically).
- **Installable PWA** with an offline app shell.

## Where the data comes from

Everything comes from the Verkehrsverbund Steiermark's HAFAS instance — the same
platform behind the official BusBahnBim app:

| Call | Used for |
|---|---|
| `JourneyGeoPos` | live vehicle positions in the viewport |
| `JourneyDetails` | a vehicle's stop list + route polyline |
| `LocGeoPos` | every stop in an area |
| `StationBoard` | live departures at a stop |
| `LocMatch` | trip-planner autocomplete |
| `TripSearch` | journey planning |

In production a tiny server-side poller (`tools/feed_poller.py`, run via systemd)
polls `JourneyGeoPos` for the whole Graz area every 5 s, snaps positions onto the
route polylines, ships the street geometry between reports, and atomically writes
a static `/api/vehicles.json` that nginx serves to every client — one upstream
request instead of one per user. Without it the client transparently falls back
to querying HAFAS directly.

Basemap tiles are keyless [CARTO](https://carto.com) vector styles rendered with
a self-hosted, pinned [MapLibre GL](https://maplibre.org) (BSD-3); the 3D
landmarks use a self-hosted [three.js](https://threejs.org) (MIT), lazy-loaded
the first time 3D is switched on.

Canonical line names come from the official GTFS feed
(© [Mobilitätsverbünde Österreich](https://data.mobilitaetsverbuende.at),
Datenlizenz MVO), pre-processed into the 3.6 KB `lines.json`. Line **colours** are
not in that feed — they were taken from the published network plan.

The underlying data is produced by the operators who run the vehicles: Graz Linien
/ Holding Graz, ÖBB, Postbus and regional carriers.

### Two things worth knowing if you fork this

- **The HAFAS endpoint is undocumented.** The access ID (`aid`) is a value used by
  the official app. It works and the request volume matches what that app
  generates, but nothing is guaranteed — the operator could change it any day.
  Don't build anything commercial on it.
- **Positions are often interpolated**, not raw GPS: HAFAS reports where a vehicle
  *should* be given its current delay. A Bim's dot can sit a stop or two from
  reality. It's a radar, not a tracker bolted to the vehicle.

## Running it

No keys, no build step — serve the folder and open it:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Everything (MapLibre, three.js, icons) is vendored and pinned, so it works
offline-first out of the box. The optional feed proxy is a single script:

```bash
python3 tools/feed_poller.py  # writes api/vehicles.json every 5 s
```

— point it at a directory your web server serves as `/api/`, or skip it entirely
(the client falls back to direct HAFAS queries, just a little slower).

## Licence

MIT — see [LICENSE](LICENSE).

Unofficial hobby project. Not affiliated with, endorsed by, or supported by
Holding Graz or Verbund Linie. For tickets and official information use
[GrazMobil](https://www.holding-graz.at/de/mobilitaet/) or
[BusBahnBim](https://www.verbundlinie.at).
