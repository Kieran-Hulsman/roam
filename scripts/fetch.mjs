// Downloads the latest form responses from the Google Sheet as CSV.
import fs from 'node:fs/promises';
import { SHEET_ID, SHEET_CSV_URL, PATHS } from './config.mjs';

if (!SHEET_ID) {
  console.error('GOOGLE_SHEET_ID is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const res = await fetch(SHEET_CSV_URL);
if (!res.ok) {
  console.error(`Failed to fetch sheet: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const csv = await res.text();
await fs.writeFile(PATHS.rawCsv, csv);
const rows = csv.trim().split('\n').length - 1;
console.log(`Saved ${PATHS.rawCsv} (~${rows} responses)`);
