import L from 'leaflet';

// CARTO Positron tiles, recoloured by the #roam-tint SVG filter (defined in Base.astro) so land
// becomes paper, water pale blue and labels deep blue. The key ends up in tile URLs in the
// browser no matter what, so restrict it to your domains in the CARTO dashboard once hosted.
const key = import.meta.env.PUBLIC_CARTO_KEY;
const tiles = (style: string) => `https://basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png${key ? `?key=${key}` : ''}`;

export function addBasemap(map: L.Map) {
  L.tileLayer(tiles('light_nolabels'), {
    className: 'roam-tiles',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);
  // Place names only once zoomed in: zoomed out, CARTO labels continents in several languages at once.
  L.tileLayer(tiles('light_only_labels'), { className: 'roam-tiles', minZoom: 5, maxZoom: 19 }).addTo(map);
}

/** Classic teardrop pin, tip on the coordinate. `label` (a number or short text) sits in the head. */
export function pinIcon({ size = 32, label, className = '' }: { size?: number; label?: string | number; className?: string } = {}) {
  const h = Math.round((size * 44) / 32);
  const head =
    label != null
      ? `<circle cx="16" cy="15.5" r="8.5" class="pin-dot"/><text x="16" y="19.6" text-anchor="middle" class="pin-label">${label}</text>`
      : `<circle cx="16" cy="15.5" r="5.5" class="pin-dot"/>`;
  return L.divIcon({
    className: `roam-pin ${className}`,
    html: `<svg viewBox="0 0 32 44" width="${size}" height="${h}" aria-hidden="true"><path class="pin-body" d="M16 1C7.7 1 1 7.6 1 15.8 1 26.5 16 43 16 43S31 26.5 31 15.8C31 7.6 24.3 1 16 1Z"/>${head}</svg>`,
    iconSize: [size, h],
    iconAnchor: [size / 2, h],
    popupAnchor: [0, -h + 4],
    tooltipAnchor: [size / 2, -h * 0.65],
  });
}
