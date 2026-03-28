/**
 * Road-aware hazard lookup (NOT connected to the main server).
 *
 * This module queries the Overpass API to get the actual road geometry
 * the device is on, then finds hazards that lie along that road rather
 * than just within a simple radius. This gives much more accurate results
 * on winding roads or when two parallel roads are close together.
 *
 * To connect this, swap the simple radius lookup in main.ts with
 * findHazardsAlongRoad().
 */

import { haversineDistance } from "./geo.ts";
import type { StoredHazardEvent } from "./types.ts";

const OVERPASS_API = "https://overpass-api.de/api/interpreter";

interface LatLon {
  lat: number;
  lon: number;
}

interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: LatLon[];
}

/**
 * Query Overpass for the road(s) near a given point.
 * Returns the OSM ways with their full geometry (node coordinates).
 */
async function fetchNearbyRoads(
  lat: number,
  lon: number,
  radiusM: number = 30,
): Promise<OsmWay[]> {
  // Overpass QL: find ways tagged as roads near the point, with geometry
  const query = `
    [out:json][timeout:10];
    way(around:${radiusM},${lat},${lon})["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];
    out geom;
  `;

  const res = await fetch(OVERPASS_API, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    console.error(`Overpass error: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.elements ?? []).filter(
    (el: { type: string }) => el.type === "way",
  ) as OsmWay[];
}

/**
 * Pick the best-matching road from candidates using bearing comparison.
 * The road whose segment near the device most closely matches the
 * device's heading is chosen.
 */
function pickBestRoad(
  roads: OsmWay[],
  lat: number,
  lon: number,
  bearingDeg: number,
): OsmWay | null {
  if (roads.length === 0) return null;

  let best: OsmWay | null = null;
  let bestScore = Infinity;

  for (const road of roads) {
    // Find the closest segment on this road
    let closestDist = Infinity;
    let segBearing = 0;

    for (let i = 0; i < road.geometry.length - 1; i++) {
      const a = road.geometry[i];
      const b = road.geometry[i + 1];
      const midLat = (a.lat + b.lat) / 2;
      const midLon = (a.lon + b.lon) / 2;
      const dist = haversineDistance(lat, lon, midLat, midLon);

      if (dist < closestDist) {
        closestDist = dist;
        // Bearing of this road segment
        const dLon = ((b.lon - a.lon) * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos((b.lat * Math.PI) / 180);
        const x =
          Math.cos((a.lat * Math.PI) / 180) *
            Math.sin((b.lat * Math.PI) / 180) -
          Math.sin((a.lat * Math.PI) / 180) *
            Math.cos((b.lat * Math.PI) / 180) *
            Math.cos(dLon);
        segBearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
      }
    }

    // Score = distance to road + bearing mismatch penalty
    // Roads go both directions, so check both bearings
    const bearingDiff = Math.min(
      Math.abs(((bearingDeg - segBearing + 540) % 360) - 180),
      Math.abs(((bearingDeg - ((segBearing + 180) % 360) + 540) % 360) - 180),
    );
    const score = closestDist + bearingDiff * 2; // weight bearing mismatch

    if (score < bestScore) {
      bestScore = score;
      best = road;
    }
  }

  return best;
}

/**
 * Check if a point is within `thresholdM` of any segment of a road.
 */
function isPointOnRoad(
  road: OsmWay,
  lat: number,
  lon: number,
  thresholdM: number = 30,
): boolean {
  for (let i = 0; i < road.geometry.length - 1; i++) {
    const a = road.geometry[i];
    const b = road.geometry[i + 1];

    // Project point onto segment (approximate with flat-earth for short distances)
    const dist = pointToSegmentDistance(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (dist <= thresholdM) return true;
  }
  return false;
}

/**
 * Approximate distance from a point to a line segment in meters.
 * Uses local flat-earth projection which is fine for short distances.
 */
function pointToSegmentDistance(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const cosLat = Math.cos((pLat * Math.PI) / 180);
  // Convert to meters relative to point A
  const px = (pLon - aLon) * cosLat * 111_320;
  const py = (pLat - aLat) * 110_540;
  const bx = (bLon - aLon) * cosLat * 111_320;
  const by = (bLat - aLat) * 110_540;

  const segLenSq = bx * bx + by * by;
  if (segLenSq === 0) return Math.sqrt(px * px + py * py);

  // Parameter t of the projection onto the segment, clamped to [0, 1]
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq));
  const projX = t * bx;
  const projY = t * by;

  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/**
 * Estimate distance along a road from the device position to a hazard point.
 * Walks the road geometry segments to accumulate path distance.
 */
function distanceAlongRoad(
  road: OsmWay,
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number | null {
  // Find the segment index closest to "from" and "to"
  const fromIdx = closestSegmentIndex(road, fromLat, fromLon);
  const toIdx = closestSegmentIndex(road, toLat, toLon);

  if (fromIdx === null || toIdx === null) return null;
  if (fromIdx === toIdx) {
    return haversineDistance(fromLat, fromLon, toLat, toLon);
  }

  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  let dist = 0;

  for (let i = start; i < end; i++) {
    const a = road.geometry[i];
    const b = road.geometry[i + 1];
    dist += haversineDistance(a.lat, a.lon, b.lat, b.lon);
  }

  return dist;
}

function closestSegmentIndex(
  road: OsmWay,
  lat: number,
  lon: number,
): number | null {
  let best = Infinity;
  let bestIdx: number | null = null;

  for (let i = 0; i < road.geometry.length - 1; i++) {
    const a = road.geometry[i];
    const b = road.geometry[i + 1];
    const dist = pointToSegmentDistance(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (dist < best) {
      best = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Road-aware hazard lookup.
 *
 * 1. Query Overpass for roads near the device
 * 2. Pick the best-matching road by proximity + bearing
 * 3. Filter candidate hazard events to those that lie on the same road
 * 4. Compute along-road distances
 *
 * @param candidateEvents - pre-fetched events within a broad radius (from storage)
 * @param lat - device latitude
 * @param lon - device longitude
 * @param bearingDeg - device heading
 * @param maxDistanceM - max along-road distance to include
 */
export async function findHazardsAlongRoad(
  candidateEvents: StoredHazardEvent[],
  lat: number,
  lon: number,
  bearingDeg: number,
  maxDistanceM: number = 1600,
): Promise<{
  road: OsmWay | null;
  hazards: { event: StoredHazardEvent; road_distance_m: number }[];
}> {
  const roads = await fetchNearbyRoads(lat, lon);
  const road = pickBestRoad(roads, lat, lon, bearingDeg);

  if (!road) {
    return { road: null, hazards: [] };
  }

  const hazards: { event: StoredHazardEvent; road_distance_m: number }[] = [];

  for (const event of candidateEvents) {
    const eLat = event.location.latitude;
    const eLon = event.location.longitude;

    // Check if the hazard is actually on this road
    if (!isPointOnRoad(road, eLat, eLon, 25)) continue;

    // Compute along-road distance
    const roadDist = distanceAlongRoad(road, lat, lon, eLat, eLon);
    if (roadDist !== null && roadDist <= maxDistanceM) {
      hazards.push({ event, road_distance_m: roadDist });
    }
  }

  // Sort by along-road distance
  hazards.sort((a, b) => a.road_distance_m - b.road_distance_m);

  return { road, hazards };
}
