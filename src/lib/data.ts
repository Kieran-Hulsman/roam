import raw from '../data/places.json';

export interface Recommender {
  personId: string;
  rating: number | null;
  note: string | null;
}

export interface Photo {
  url: string;
  author: string | null;
  authorUrl: string | null;
}

export interface Spot {
  id: string;
  name: string;
  type: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  googleMapsUrl: string | null;
  appleMapsUrl: string | null;
  photo: Photo | null;
  recommenders: Recommender[];
}

export interface City {
  slug: string;
  name: string;
  country: string;
  flag: string | null;
  lat: number;
  lng: number;
  photo: Photo | null;
  spots: Spot[];
}

export interface Person {
  name: string;
  country: string | null;
  flag: string | null;
  bio: string | null;
}

export const data = raw as { generatedAt: string; cities: City[]; people: Record<string, Person> };
export const { cities, people } = data;

export const cityUrl = (c: City) => `/city/${c.slug}`;

export function cityPeople(c: City): string[] {
  return [...new Set(c.spots.flatMap((s) => s.recommenders.map((r) => r.personId)))];
}

export function averageRating(s: Spot): number | null {
  const ratings = s.recommenders.map((r) => r.rating).filter((r): r is number => r != null);
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
}

/** Other cities a person has recommended spots in. */
export function citiesFor(personId: string): City[] {
  return cities.filter((c) => c.spots.some((s) => s.recommenders.some((r) => r.personId === personId)));
}

/** Average of every rating given to spots in a city. */
export function cityAverage(c: City): number | null {
  const ratings = c.spots.flatMap((s) => s.recommenders.map((r) => r.rating)).filter((r): r is number => r != null);
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10;
}

export const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

/** "Agith", "Agith & Sofia", "Agith, Sofia & 3 more" */
export function nameList(names: string[], max = 2): string {
  if (names.length <= max) return names.join(' & ');
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} & ${rest} more`;
}
