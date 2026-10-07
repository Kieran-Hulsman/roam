// Thin wrapper around the Google Places API (New) Text Search, with a disk cache
// so each distinct query is only ever paid for once.
import fs from 'node:fs/promises';
import { PATHS } from './config.mjs';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.googleMapsUri',
  'places.types',
  'places.primaryTypeDisplayName',
].join(',');

let cache = null;
let dirty = false;
export let apiCalls = 0;

export async function loadCache() {
  try {
    cache = JSON.parse(await fs.readFile(PATHS.cache, 'utf8'));
  } catch {
    cache = {};
  }
  cache.search ??= {};
  cache.links ??= {};
  cache.photos ??= {};
}

export async function saveCache() {
  if (!dirty) return;
  await fs.writeFile(PATHS.cache, JSON.stringify(cache, null, 2) + '\n');
  dirty = false;
}

/** Returns the top match for a text query, or null. `near` biases results towards {lat, lng}. */
export async function searchPlace(textQuery, near) {
  const key = near ? `${textQuery} @${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : textQuery;
  if (key in cache.search) return cache.search[key];

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set. Add it to .env (see .env.example).');
  }

  const body = { textQuery, pageSize: 1 };
  if (near) {
    body.locationBias = {
      circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 },
    };
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELDS,
    },
    body: JSON.stringify(body),
  });
  apiCalls++;
  if (!res.ok) {
    throw new Error(`Places API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const p = data.places?.[0];
  const result = p
    ? {
        placeId: p.id,
        name: p.displayName?.text ?? '',
        address: p.formattedAddress ?? '',
        lat: p.location.latitude,
        lng: p.location.longitude,
        googleMapsUri: p.googleMapsUri,
        types: p.types ?? [],
        typeLabel: p.primaryTypeDisplayName?.text ?? null,
      }
    : null;

  cache.search[key] = result;
  dirty = true;
  return result;
}

const PHOTO_MAX_AGE_DAYS = 30;

/**
 * A photo of a place: { url, author, authorUrl } or null. `index` picks a different one of the
 * place's photos. Google's image URLs aren't meant to live forever, so they're re-fetched after
 * PHOTO_MAX_AGE_DAYS; the photographer credit must be shown wherever the photo is.
 */
export async function getPhoto(placeId, index = 0) {
  const key = `${placeId}#${index}`;
  const hit = cache.photos[key];
  if (hit !== undefined && Date.now() - Date.parse(hit.fetchedAt) < PHOTO_MAX_AGE_DAYS * 864e5) {
    return hit.photo;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set. Add it to .env (see .env.example).');

  const details = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' },
  });
  apiCalls++;
  if (!details.ok) throw new Error(`Places API ${details.status}: ${await details.text()}`);
  const ref = (await details.json()).photos?.[index];

  let photo = null;
  if (ref) {
    const media = await fetch(
      `https://places.googleapis.com/v1/${ref.name}/media?maxWidthPx=1200&skipHttpRedirect=true&key=${apiKey}`,
    );
    apiCalls++;
    if (!media.ok) throw new Error(`Places photo ${media.status}: ${await media.text()}`);
    const author = ref.authorAttributions?.[0];
    photo = { url: (await media.json()).photoUri, author: author?.displayName ?? null, authorUrl: author?.uri ?? null };
  }

  cache.photos[key] = { photo, fetchedAt: new Date().toISOString() };
  dirty = true;
  return photo;
}

/** Expands a maps.app.goo.gl short link and pulls a place name out of the final URL. */
export async function placeNameFromMapsLink(url) {
  if (url in cache.links) return cache.links[url];
  let name = null;
  try {
    let current = url;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(current, { redirect: 'manual' });
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
    }
    const m = current.match(/\/maps\/place\/([^/@?]+)/);
    const q = new URL(current).searchParams.get('q');
    name = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : q;
  } catch {
    name = null;
  }
  cache.links[url] = name;
  dirty = true;
  return name;
}
