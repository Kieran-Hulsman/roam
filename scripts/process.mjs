// Turns data/raw/responses.csv into src/data/places.json.
//
//   1. normalize  – flatten each response into one entry per spot, canonicalize city names
//   2. resolve    – look up every city and spot with the Places API (cached)
//   3. build      – group spots by city, merge duplicates, attach people
//
// Manual fixes live in data/overrides.json; anything that needs a human (or Claude)
// to look at it is written to data/review.md. See PROCESSING.md.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { PATHS, COLS, MAX_SPOT_DISTANCE_KM } from './config.mjs';
import { loadCache, saveCache, searchPlace, placeNameFromMapsLink, getPhoto, apiCalls } from './places-api.mjs';

// ---------- helpers ----------

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normKey = (s) => stripAccents(s).toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
const slugify = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => s.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
const firstName = (s) => (s ?? '').trim().split(/\s+/)[0] ?? '';

const URL_RE = /https?:\/\/\S+/g;

function flagEmoji(code) {
  if (!/^[A-Za-z]{2}$/.test(code ?? '')) return null;
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

// "Canada" / "USA" / "United Kingdom" → ISO code, via the platform's own country names.
const COUNTRY_ALIASES = { usa: 'US', us: 'US', 'united states of america': 'US', uk: 'GB', england: 'GB', scotland: 'GB' };
const countryCodes = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const map = { ...COUNTRY_ALIASES };
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const name = names.of(code);
        if (name && name !== code) map[normKey(name)] ??= code;
      } catch {}
    }
  return map;
})();
const countryCode = (country) => countryCodes[normKey(country ?? '')] ?? null;

function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Drops pasted links and stray separators left behind.
function cleanSpotText(text) {
  return text
    .replace(URL_RE, '')
    .replace(/^\s*[-–—:]\s*|\s*[-–—:]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// People write "$4 banh mi downtown: Thai Thien Sub, 811a 1 St SW" — split into parts.
const segments = (text) => text.split(/\s*:\s+|\s+[-–—]\s+|\.\s+/).map((s) => s.trim()).filter(Boolean);
const tokens = (s) => stripAccents(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

/**
 * How much of what the person wrote shows up in the matched place's name/address (0–1).
 * Catches lookups that returned *something* in the city that isn't what they meant.
 */
function matchScore(text, place, cityName) {
  const ignore = new Set(['the', 'and', ...(cityName ? tokens(cityName) : [])]);
  const hay = tokens(`${place.name} ${place.address}`).join(' ');
  const scoreOf = (part) => {
    const ts = tokens(part).filter((t) => !ignore.has(t));
    if (!ts.length) return 1;
    const hits = ts.filter((t) => hay.includes(t) || (t.length >= 6 && hay.includes(t.slice(0, 5))));
    return hits.length / ts.length;
  };
  return Math.max(scoreOf(text), ...segments(text).map(scoreOf));
}
const STRONG_MATCH = 0.6;

// ---------- load ----------

const csv = await fs.readFile(PATHS.rawCsv, 'utf8');
const rows = parse(csv, { relax_column_count: true }).slice(1);
const peopleFile = await readJson(PATHS.people, {});
const overrides = await readJson(PATHS.overrides, { cityAliases: {}, cities: {}, entries: {} });
overrides.cityAliases ??= {};
overrides.cities ??= {};
overrides.entries ??= {};
const cityAliases = Object.fromEntries(Object.entries(overrides.cityAliases).map(([k, v]) => [normKey(k), v]));

function canonicalCity(raw) {
  if (!raw?.trim()) return null;
  const key = normKey(raw);
  if (cityAliases[key]) return cityAliases[key];
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(/\s*,\s*/)
    .map((part) => titleCase(part))
    .join(', ');
}

// ---------- 1. normalize ----------

const people = new Map(); // personId -> person
const entries = [];

for (const row of rows) {
  const cell = (i) => (row[i] ?? '').trim();
  const email = cell(COLS.email).toLowerCase();
  const timestamp = cell(COLS.timestamp);
  if (!email && !timestamp) continue;

  const rowId = hash(`${timestamp}|${email}`);
  const personId = hash(email || rowId);

  // Make sure every respondent has a slot in people.json so names/countries can be filled in.
  if (email && !peopleFile[email]) {
    peopleFile[email] = { name: firstName(cell(COLS.name)), country: '' };
  }
  const manual = peopleFile[email] ?? {};
  const prev = people.get(personId);
  people.set(personId, {
    id: personId,
    email,
    name: manual.name || firstName(cell(COLS.name)) || prev?.name || '',
    country: (manual.country || prev?.country || '').toUpperCase(),
    bio: manual.bio || cell(COLS.bio) || prev?.bio || '',
  });

  const rowCities = COLS.groups.map((g) => canonicalCity(cell(g.city)));

  COLS.groups.forEach((group, g) => {
    group.spots.forEach((col, s) => {
      const text = cell(col);
      if (!text) return;
      const id = `${rowId}-${g + 1}-${s + 1}`;
      const ov = overrides.entries[id] ?? {};
      if (ov.skip) return;
      const rating = Number(cell(COLS.ratingStart + g * 3 + s)) || null;
      entries.push({
        id,
        personId,
        text,
        rating,
        city: ov.city ?? rowCities[g],
        cityLocked: Boolean(ov.city),
        otherCities: rowCities.filter((c, i) => c && i !== g),
        ov,
      });
    });
  });
}

// ---------- 2. resolve ----------

await loadCache();
const flags = [];
const autoFixes = [];

const cityInfo = new Map(); // city name -> {lat, lng, ...}
async function resolveCity(name) {
  if (cityInfo.has(name)) return cityInfo.get(name);
  const ov = overrides.cities[name] ?? {};
  let info;
  if (ov.lat != null && ov.lng != null) {
    info = { lat: ov.lat, lng: ov.lng };
  } else {
    const place = await searchPlace(ov.query ?? name);
    info = place ? { lat: place.lat, lng: place.lng, placeId: place.placeId } : null;
    if (!place) flags.push({ kind: 'city-not-found', city: name });
  }
  cityInfo.set(name, info);
  return info;
}

try {
  for (const e of entries) {
    if (e.ov.textOnly) {
      e.place = null;
      continue;
    }

    // A pasted Google Maps link expands to the exact name + address, which beats their text.
    const link = e.text.match(URL_RE)?.[0];
    const linkQuery = !e.ov.query && link ? await placeNameFromMapsLink(link) : null;
    const query = e.ov.query ?? linkQuery ?? cleanSpotText(e.text);
    if (!query) {
      e.place = null;
      flags.push({ kind: 'empty-query', entry: e });
      continue;
    }

    // Try the city the person put it under first, then (unless an override pinned the city)
    // their other cities, since the form makes it easy to put a spot in the wrong group.
    // A result only counts if it's near that city AND resembles what they wrote.
    const candidates = [...new Set([e.city, ...(e.cityLocked ? [] : e.otherCities)].filter(Boolean))];
    const tries = [];
    if (linkQuery) {
      const place = await searchPlace(linkQuery);
      for (const city of candidates) {
        const centre = await resolveCity(city);
        if (place) tries.push({ place, city, km: centre ? distanceKm(centre, place) : Infinity, score: 1 });
      }
      if (place && !candidates.length) tries.push({ place, city: null, km: Infinity, score: 1 });
    } else if (candidates.length) {
      for (const city of candidates) {
        const centre = await resolveCity(city);
        const place = await searchPlace(`${query}, ${city}`, centre ?? undefined);
        if (!place) continue;
        const km = centre ? distanceKm(centre, place) : Infinity;
        tries.push({ place, city, km, score: matchScore(query, place, city) });
        if (km <= MAX_SPOT_DISTANCE_KM && tries.at(-1).score >= STRONG_MATCH) break;
      }
    } else {
      const place = await searchPlace(query);
      if (place) tries.push({ place, city: null, km: Infinity, score: matchScore(query, place) });
    }

    const near = tries.filter((t) => t.km <= MAX_SPOT_DISTANCE_KM);
    const chosen =
      near.find((t) => t.score >= STRONG_MATCH) ??
      // Nothing convincing: stay in the original city if it had a nearby result, else the best nearby one.
      near.find((t) => t.city === e.city) ??
      near.sort((a, b) => b.score - a.score)[0];

    if (chosen) {
      if (chosen.city !== e.city) {
        autoFixes.push({ entry: e, from: e.city, to: chosen.city, place: chosen.place });
        e.city = chosen.city;
      }
      e.place = chosen.place;
      if (chosen.score < STRONG_MATCH && !e.ov.acceptMatch) {
        flags.push({ kind: 'weak-match', entry: e, score: chosen.score });
      }
    } else if (tries.length) {
      const first = tries.find((t) => t.city === e.city) ?? tries[0];
      e.place = first.place;
      if (!e.city) {
        flags.push({ kind: 'no-city', entry: e });
      } else if (!e.ov.acceptFar) {
        flags.push({ kind: 'far-from-city', entry: e, km: Number.isFinite(first.km) ? Math.round(first.km) : null });
      }
    } else {
      e.place = null;
      flags.push({ kind: 'not-found', entry: e, query });
    }

    const genericTypes = ['locality', 'political', 'country', 'administrative_area_level_1', 'administrative_area_level_2'];
    if (e.place && !e.ov.acceptMatch && e.place.types.length && e.place.types.every((t) => genericTypes.includes(t))) {
      flags.push({ kind: 'area-match', entry: e });
    }
  }
  for (const e of entries) if (e.city) await resolveCity(e.city);

  // Photos. Overrides: `photo: false` hides a bad one, `photoIndex: n` picks another of the place's photos.
  for (const [name, info] of cityInfo) {
    const ov = overrides.cities[name] ?? {};
    if (info?.placeId && ov.photo !== false) info.photo = await getPhoto(info.placeId, ov.photoIndex ?? 0);
  }
  for (const e of entries) {
    if (e.place && e.ov.photo !== false) e.photo = await getPhoto(e.place.placeId, e.ov.photoIndex ?? 0);
  }
} finally {
  await saveCache();
}

// ---------- 3. build ----------

const cities = new Map();
for (const e of entries) {
  if (!e.city) continue; // can't place it until an override gives it a city
  const info = cityInfo.get(e.city);
  if (!info) continue;

  if (!cities.has(e.city)) {
    const [cityName, ...rest] = e.city.split(', ');
    cities.set(e.city, {
      slug: slugify(e.city),
      name: cityName,
      country: rest.join(', '),
      flag: flagEmoji(countryCode(rest.join(', ')) ?? (rest.length ? null : countryCode(cityName))),
      lat: info.lat,
      lng: info.lng,
      photo: info.photo ?? null,
      spots: new Map(),
    });
  }
  const city = cities.get(e.city);

  const p = e.place;
  const name = e.ov.name ?? p?.name ?? cleanSpotText(e.text);
  const spotKey = p?.placeId ?? `text:${normKey(name)}`;
  if (!city.spots.has(spotKey)) {
    city.spots.set(spotKey, {
      id: p?.placeId ? slugify(name) || hash(spotKey) : hash(spotKey),
      name,
      type: e.ov.type ?? p?.typeLabel ?? null,
      address: p?.address ?? null,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
      googleMapsUrl: p?.googleMapsUri ?? null,
      appleMapsUrl: p ? `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${p.lat},${p.lng}` : null,
      photo: e.photo ?? null,
      recommenders: [],
    });
  }

  // Keep what the person actually wrote when it says more than the place itself,
  // e.g. "$4 banh mi downtown" from "$4 banh mi downtown: Thai Thien Sub, 811a 1 St SW".
  const cleaned = cleanSpotText(e.text);
  let note = e.ov.note;
  if (note === undefined) {
    if (!p) {
      note = normKey(cleaned) === normKey(name) ? null : cleaned;
    } else {
      const extra = segments(cleaned).filter((seg) => seg.split(/\s+/).length >= 2 && matchScore(seg, p, e.city) < STRONG_MATCH);
      note = extra.join(' — ') || null;
    }
  }

  const spot = city.spots.get(spotKey);
  if (!spot.recommenders.some((r) => r.personId === e.personId)) {
    spot.recommenders.push({ personId: e.personId, rating: e.rating, note: note || null });
  }
}

const usedPeople = new Set();
const output = {
  generatedAt: new Date().toISOString(),
  cities: [...cities.values()]
    .map((c) => {
      const spots = [...c.spots.values()].sort((a, b) => b.recommenders.length - a.recommenders.length || a.name.localeCompare(b.name));
      spots.forEach((s) => s.recommenders.forEach((r) => usedPeople.add(r.personId)));
      return { ...c, spots };
    })
    .sort((a, b) => b.spots.length - a.spots.length || a.name.localeCompare(b.name)),
  people: {},
};

const missingPeople = [];
for (const id of usedPeople) {
  const p = people.get(id);
  // Emails stay out of the output on purpose.
  output.people[id] = { name: p.name || 'Anonymous', country: p.country || null, flag: flagEmoji(p.country), bio: p.bio || null };
  if (!p.name || !p.country) missingPeople.push(p);
}

await writeJson(PATHS.output, output);
await writeJson(
  PATHS.people,
  Object.fromEntries(Object.entries(peopleFile).sort(([a], [b]) => a.localeCompare(b))),
);

// ---------- review report ----------

const personName = (id) => people.get(id)?.name || people.get(id)?.email || id;
const describe = (e) => `\`${e.id}\` · ${personName(e.personId)} · **${e.city ?? '(no city)'}** · "${e.text}"`;
const matched = (p) => (p ? ` → ${p.name} (${p.address})` : '');

const lines = ['# Review', '', `Generated ${output.generatedAt}. Fix things in \`data/overrides.json\`, then re-run \`npm run data:process\`.`, ''];
const section = (title, items) => {
  lines.push(`## ${title} (${items.length})`, '');
  if (!items.length) lines.push('_Nothing here._');
  lines.push(...items, '');
};

section(
  'Needs attention',
  flags.map((f) => {
    switch (f.kind) {
      case 'city-not-found':
        return `- **city not found**: "${f.city}" — add \`cities["${f.city}"].query\` or lat/lng`;
      case 'no-city':
        return `- **no city**: ${describe(f.entry)}${matched(f.entry.place)} — set \`city\``;
      case 'far-from-city':
        return `- **${f.km ?? '?'} km from city**: ${describe(f.entry)}${matched(f.entry.place)} — fix \`city\`/\`query\`, or \`acceptFar\``;
      case 'not-found':
        return `- **not found**: ${describe(f.entry)} (query "${f.query}") — set \`query\` or \`textOnly\``;
      case 'empty-query':
        return `- **nothing to search**: ${describe(f.entry)} — set \`query\`, \`textOnly\` or \`skip\``;
      case 'weak-match':
        return `- **doesn't look like what they wrote** (${Math.round(f.score * 100)}%): ${describe(f.entry)}${matched(f.entry.place)} — fix \`query\`/\`city\`, or \`acceptMatch\``;
      case 'area-match':
        return `- **matched an area, not a place**: ${describe(f.entry)}${matched(f.entry.place)} — check, then \`acceptMatch\`/\`query\`/\`textOnly\``;
    }
  }),
);
section(
  'Moved to another of the person’s cities automatically',
  autoFixes.map((f) => `- ${describe(f.entry)} moved from ${f.from} → **${f.to}**${matched(f.place)}`),
);
section(
  'People missing a name or country (edit data/people.json)',
  missingPeople.map((p) => `- ${p.email || p.id}: name "${p.name}", country "${p.country}"`),
);
section(
  'All entries',
  entries.map((e) => `- ${e.ov.textOnly ? '[text only] ' : ''}${describe(e)}${matched(e.place)}`),
);
await fs.writeFile(PATHS.review, lines.join('\n'));

console.log(
  `${entries.length} entries → ${output.cities.length} cities, ${output.cities.reduce((n, c) => n + c.spots.length, 0)} spots. ` +
    `${apiCalls} Places API calls. ${flags.length} flagged, ${autoFixes.length} auto-moved. See data/review.md`,
);
