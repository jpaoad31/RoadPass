import type { RoadInfo } from "./types.ts";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

/**
 * Reverse geocode a lat/lon to get road info from Nominatim.
 * Respects the 1 req/sec rate limit via the caller — this function
 * does not throttle internally.
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<RoadInfo> {
  const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "RoadPass-HazardServer/0.1 (demo)",
    },
  });

  if (!res.ok) {
    console.error(`Nominatim error: ${res.status} ${res.statusText}`);
    return { osm_way_id: null, road_name: null, road_ref: null, display_name: null };
  }

  const data = await res.json();

  return {
    osm_way_id: data.osm_type === "way" ? String(data.osm_id) : null,
    road_name: data.address?.road ?? data.name ?? null,
    road_ref: data.address?.["ref"] ?? null,
    display_name: data.display_name ?? null,
  };
}
