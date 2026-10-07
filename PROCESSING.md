# Processing new form responses

This is the repeatable runbook for turning Google Form responses into the site's data.
Follow it yourself, or point Claude Code at it ("follow PROCESSING.md").

Pipeline: **Google Sheet → `data/raw/responses.csv` → `scripts/process.mjs` → `src/data/places.json` → site**

## One-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in:
   ```
   GOOGLE_SHEET_ID=1-dc...        # from the response sheet's URL
   GOOGLE_PLACES_API_KEY=AIza...
   PUBLIC_CARTO_KEY=cb1_...
   ```
   The key needs the **Places API (New)** enabled in Google Cloud. It's only used by the
   processing script and never ends up in the site.

## Every time new responses come in

### 1. Sync

```sh
npm run data:sync      # = data:fetch (download the sheet) + data:process
```

`data:process` alone re-runs everything without re-downloading. It also fetches a Google
photo for every city and spot, with the photographer credit Google requires us to show. Google's image
URLs aren't permanent, so photos are re-fetched once they're 30 days old. Re-run this before deploying
if it's been a while. It is safe to run as often
as you like: every Places lookup is cached in `data/cache/places.json`, so only new spots
cost API calls.

### 2. Fill in people

New respondents are added automatically to `data/people.json` (keyed by email, git-ignored):

```json
"someone@uwaterloo.ca": { "name": "Sofia", "country": "PT" }
```

- `name`: first name shown on the site. Overrides whatever they typed in the form.
- `country`: two-letter ISO code (`CA`, `US`, `IN`, …). It's shown as a flag next to their name.
- `bio` (optional): overrides the bio from the form.

Emails are never written to the site's data.

### 3. Review `data/review.md`

The script writes a report with these sections:

| Section | What it means |
|---|---|
| **Needs attention** | Spots that couldn't be placed confidently. Fix each one in `data/overrides.json`. |
| **Moved automatically** | The spot was found in a different city that the *same person* listed (the form makes it easy to type a spot into the wrong group). Skim it to make sure the moves are right. |
| **People missing a name or country** | Fill these in `data/people.json`. |
| **All entries** | Every entry with its ID and what it matched. Use it to spot-check bad matches. |

Also skim **All entries** for matches that look wrong but weren't flagged, e.g. a generic
description that matched a random business.

### 4. Fix things in `data/overrides.json`

Entry IDs look like `0617c2fa-2-3`, meaning response `0617c2fa`, city group 2, spot 3. They're
stable across runs.

```jsonc
{
  // Normalize city spellings. Keys are matched case- and accent-insensitively.
  "cityAliases": { "toronto": "Toronto, Canada" },

  // Fix a city's map position if the lookup is off.
  "cities": { "Gargellen, Austria": { "query": "Gargellen, Vorarlberg" } },  // or { "lat": .., "lng": .. }
  // `photoIndex` / `photo: false` work for cities too.

  "entries": {
    "abc12345-1-2": { "query": "Thai Thien Sub, 811a 1 St SW, Calgary" }, // search for this instead
    "abc12345-1-3": { "city": "Osaka, Japan" },     // put it under this city (no auto-moving)
    "abc12345-2-1": { "name": "Skyline ridge" },    // display name on the site
    "abc12345-2-2": { "note": "their words, cleaned up" },  // the quote under their name (null = none)
    "abc12345-2-3": { "textOnly": true, "name": "Day hikes around the region" }, // vague tip, no map link
    "abc12345-3-1": { "acceptFar": true },          // yes, it's far from the city centre, that's fine
    "abc12345-3-2": { "acceptMatch": true },        // matched a neighbourhood/area on purpose
    "abc12345-3-3": { "skip": true, "_why": "duplicate" }, // hide it
    "abc12345-1-1": { "photoIndex": 2 },             // use the place's 3rd Google photo instead
    "abc12345-1-2": { "photo": false }               // no photo
  }
}
```

Keys starting with `_` are ignored, so use `_why` to leave notes for next time.

Then re-run `npm run data:process` and repeat until **Needs attention** is empty, or only lists
things you've decided are fine.

### 5. Check it and ship

```sh
npm run dev   # http://localhost:4321
```

Commit `data/overrides.json`, `data/cache/places.json` and `src/data/places.json`.
`data/raw/`, `data/people.json` and `data/review.md` contain emails, so they stay git-ignored.

## Guidance for Claude doing the review

- Use web search to work out what vague or partial entries refer to before choosing `query` or
  `textOnly`. Only turn an entry into a text-only tip when there's no specific place to link.
- Prefer a short, human `name` when the matched name is an address or very long.
- Keep `note` in the person's voice. Tidy typos and filler ("uhhh"), but don't rewrite their opinion.
- Never put emails into `overrides.json` or anything under `src/`.
- Report what you changed and anything you weren't sure about.
