# Roam

Travel advice from people you'd actually trust. A static city guide built from Google Form responses:
open a city, see the spots people recommend, who recommended them, and how to get there.

## Run it locally

```sh
npm install
cp .env.example .env   # fill in the keys (see below)
npm run dev            # http://localhost:4321
```

| Variable | Used by | Notes |
|---|---|---|
| `PUBLIC_CARTO_KEY` | the site | CARTO basemap key. Ends up in the browser, so restrict it to your domains. |
| `GOOGLE_SHEET_ID` | `npm run data:fetch` | The form's response sheet. Kept out of the repo because the sheet includes emails. |
| `GOOGLE_PLACES_API_KEY` | `npm run data:process` | Google Places API (New). Never shipped to the site. |

The site only needs `PUBLIC_CARTO_KEY`. The processed data (`src/data/places.json`) is committed, so
building and deploying don't need the Google keys.

## Adding new responses

`npm run data:sync`, then follow [PROCESSING.md](PROCESSING.md) to review anything it flags. Commit
`src/data/places.json`, `data/overrides.json` and `data/cache/places.json`, and push.

## Layout

- `scripts/`: the data pipeline (fetch the sheet, normalize, resolve places and photos, build the JSON)
- `data/`: manual overrides and the Places lookup cache. Raw responses and `people.json` contain emails and are git-ignored.
- `src/`: the Astro site (home map, all cities, a page per city)
