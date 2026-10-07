import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The response sheet includes respondents' emails, so its ID lives in .env rather than in the repo.
export const SHEET_ID = process.env.GOOGLE_SHEET_ID;
export const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

export const PATHS = {
  rawCsv: path.join(ROOT, 'data/raw/responses.csv'),
  people: path.join(ROOT, 'data/people.json'),
  overrides: path.join(ROOT, 'data/overrides.json'),
  cache: path.join(ROOT, 'data/cache/places.json'),
  review: path.join(ROOT, 'data/review.md'),
  output: path.join(ROOT, 'src/data/places.json'),
};

// Sheet column layout (header names repeat, so we go by index).
// 3 city groups × (city name + 3 spots), then 9 ratings, then name + bio.
export const COLS = {
  timestamp: 0,
  email: 1,
  groups: [
    { city: 2, spots: [3, 4, 5] },
    { city: 6, spots: [7, 8, 9] },
    { city: 10, spots: [11, 12, 13] },
  ],
  ratingStart: 14, // rating for group g, spot s (0-based) = ratingStart + g*3 + s
  name: 23,
  bio: 24,
};

// A spot further than this from its city centre gets checked against the
// person's other cities, and flagged for review if nothing fits.
export const MAX_SPOT_DISTANCE_KM = 60;
