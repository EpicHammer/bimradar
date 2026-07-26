# BimRadar

Live map of Graz trams (*Bims*) and buses — watch them move in real time, browse
stop departures, and plan a trip. One HTML file, no build step, no backend.

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

## Where the data comes from

Everything is fetched **client-side** from the Verkehrsverbund Steiermark's HAFAS
instance — the same platform behind the official BusBahnBim app:

| Call | Used for |
|---|---|
| `JourneyGeoPos` | live vehicle positions in the viewport |
| `JourneyDetails` | a vehicle's stop list + route polyline |
| `LocGeoPos` | every stop in an area |
| `StationBoard` | live departures at a stop |
| `LocMatch` | trip-planner autocomplete |
| `TripSearch` | journey planning |

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

It's one file plus a small JSON:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

You need a **Google Maps JavaScript API** key and a **vector Map ID**, set near the
top of the script:

```js
const GMAPS_KEY = 'your-key';
const MAP_ID    = 'your-vector-map-id';
```

The Map ID must be created with **Vector** rendering — raster tiles show visible
seams under a dark style. Because a `mapId` and a `styles` array are mutually
exclusive, POI/transit-icon hiding is done with a cloud map style attached to the
Map ID (otherwise Google's own transit icons duplicate our stop badges).

The key committed here is a browser key restricted by HTTP referrer to this app's
domains and capped by quota. Browser Maps keys are inherently public — use your
own, restricted to your domain, if you fork this.

## Licence

MIT — see [LICENSE](LICENSE).

Unofficial hobby project. Not affiliated with, endorsed by, or supported by
Holding Graz or Verbund Linie. For tickets and official information use
[GrazMobil](https://www.holding-graz.at/de/mobilitaet/) or
[BusBahnBim](https://www.verbundlinie.at).
