# Sydney vehicle playback

A static web page that replays 24 hours of Sydney public transport vehicle
positions on a zoomable map: buses, trains, metro, ferries and light rail,
moving smoothly between their recorded GPS reports.

**Live site:** https://maxim75.github.io/tfnsw-playback-map/

- Time slider across the day (the strip under it shows when data was recorded),
  play/pause (space bar), 1×–120× speed, jump to a time. Open with
  `#HH:MM` in the URL to start at that time, e.g. `…/#17:30`.
- Filter by mode and route, colour by route, speed or mode, fading trails.
  Zoom in for direction arrows and route numbers.
- Built with [MapLibre GL JS](https://maplibre.org) on
  [OpenFreeMap](https://openfreemap.org) vector tiles and
  [deck.gl](https://deck.gl) WebGL layers. No build step, no server code.

## Data

Vehicle positions come from the Transport for NSW Open Data GTFS-Realtime
feeds, recorded every 30 s by
[tfnsw_realtime_recorder](https://github.com/maxim75/tfnsw_realtime_recorder)
(private). Contains Transport for NSW data, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

```
data/index.json            day bounds (Sydney time), windows with data, feeds
data/w/<start>.json.gz     one compact file per 10-minute window
```

The page loads only the windows it is about to play. Each window lists its
vehicles once, with their reports as delta-encoded columns (format described
in the recorder's `recorder/static_export.py`); a full day is roughly 15 MB.

### Publishing another day

From the recorder repository (needs its `.env` with the S3 settings):

```bash
uv run export_static.py --date 2026-10-17 --out ../tfnsw-playback-map/data
```

Then commit and push `data/` here; GitHub Pages updates within a minute or two.

## Run locally

Any static file server works, for example:

```bash
python3 -m http.server 8000
```

and open http://127.0.0.1:8000.
