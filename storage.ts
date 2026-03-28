import type { StoredHazardEvent, StoredHazard } from "./types.ts";
import { haversineDistance } from "./geo.ts";

const kv = await Deno.openKv();

/** Store a new hazard event. Returns false if event_id already exists. */
export async function createEvent(
  event: StoredHazardEvent,
): Promise<boolean> {
  const key = ["events", event.event_id];
  const existing = await kv.get(key);
  if (existing.value !== null) return false;

  // Primary record keyed by event_id
  const tx = kv.atomic();
  tx.check(existing); // optimistic concurrency — fail if someone raced us
  tx.set(key, event);

  // Secondary index: by location bucket (0.01° ≈ 1.1km grid) for spatial scans
  const latBucket = Math.round(event.location.latitude * 100);
  const lonBucket = Math.round(event.location.longitude * 100);
  tx.set(["geo", latBucket, lonBucket, event.event_id], event.event_id);

  // Secondary index: by dongle_id for per-device queries
  tx.set(
    ["dongle", event.dongle_id, event.detected_at_ms, event.event_id],
    event.event_id,
  );

  const result = await tx.commit();
  return result.ok;
}

/** Update the response fields on an existing event. */
export async function updateResponse(
  eventId: string,
  answer: "yes" | "no" | "timeout",
  latencyS: number,
): Promise<StoredHazardEvent | null> {
  const key = ["events", eventId];
  const existing = await kv.get<StoredHazardEvent>(key);
  if (existing.value === null) return null;

  const updated: StoredHazardEvent = {
    ...existing.value,
    response: { answer, latency_s: latencyS },
    responded_at: new Date().toISOString(),
  };

  const tx = kv.atomic();
  tx.check(existing);
  tx.set(key, updated);
  const result = await tx.commit();
  return result.ok ? updated : null;
}

/** Get a single event by ID. */
export async function getEvent(
  eventId: string,
): Promise<StoredHazardEvent | null> {
  const result = await kv.get<StoredHazardEvent>(["events", eventId]);
  return result.value;
}

/**
 * Find all events near a location within a search radius.
 * Scans geo-bucketed secondary indexes, then loads full events.
 * Returns events sorted by distance (closest first).
 */
export async function findEventsNear(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<StoredHazardEvent[]> {
  // Figure out how many 0.01° buckets to scan in each direction.
  // 0.01° latitude ≈ 1,111m. For longitude, it varies by latitude.
  const latSpan = Math.ceil(radiusM / 1111) + 1;
  const lonDegreesPerM = 111_320 * Math.cos((lat * Math.PI) / 180);
  const lonSpan = Math.ceil(radiusM / (lonDegreesPerM * 0.01)) + 1;

  const centerLatBucket = Math.round(lat * 100);
  const centerLonBucket = Math.round(lon * 100);

  const eventIds = new Set<string>();

  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      const entries = kv.list<string>({
        prefix: ["geo", centerLatBucket + dLat, centerLonBucket + dLon],
      });
      for await (const entry of entries) {
        eventIds.add(entry.value);
      }
    }
  }

  const events: StoredHazardEvent[] = [];
  for (const id of eventIds) {
    const event = await getEvent(id);
    if (event) events.push(event);
  }

  return events;
}

/** List up to `limit` events, newest first. */
export async function listEvents(limit = 100): Promise<StoredHazardEvent[]> {
  const events: StoredHazardEvent[] = [];
  const entries = kv.list<StoredHazardEvent>({ prefix: ["events"] });
  for await (const entry of entries) {
    events.push(entry.value);
    if (events.length >= limit) break;
  }
  events.sort((a, b) => b.detected_at_ms - a.detected_at_ms);
  return events;
}

// ── Aggregated hazards ───────────────────────────────────────────────

const HAZARD_MERGE_RADIUS_M = 30;

/** Find an existing hazard near a location, or null. */
export async function findNearbyHazard(
  lat: number,
  lon: number,
): Promise<StoredHazard | null> {
  // Scan hazard geo index within a small radius
  const latBucket = Math.round(lat * 100);
  const lonBucket = Math.round(lon * 100);

  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const entries = kv.list<string>({
        prefix: ["hazard_geo", latBucket + dLat, lonBucket + dLon],
      });
      for await (const entry of entries) {
        const hazard = await getHazard(entry.value);
        if (hazard && haversineDistance(lat, lon, hazard.latitude, hazard.longitude) <= HAZARD_MERGE_RADIUS_M) {
          return hazard;
        }
      }
    }
  }
  return null;
}

/** Get a hazard by ID. */
export async function getHazard(hazardId: string): Promise<StoredHazard | null> {
  const result = await kv.get<StoredHazard>(["hazards", hazardId]);
  return result.value;
}

/**
 * Create or update an aggregated hazard when a new event comes in.
 * If an existing hazard is within 30m, the event is linked to it.
 * Otherwise a new hazard is created.
 * Returns the hazard ID.
 */
export async function upsertHazardForEvent(
  eventId: string,
  lat: number,
  lon: number,
): Promise<string> {
  const existing = await findNearbyHazard(lat, lon);

  if (existing) {
    // Link event to existing hazard
    const key = ["hazards", existing.hazard_id];
    const current = await kv.get<StoredHazard>(key);
    if (!current.value) return existing.hazard_id;

    const updated: StoredHazard = {
      ...current.value,
      report_count: current.value.report_count + 1,
      last_reported_at: new Date().toISOString(),
      event_ids: [...current.value.event_ids, eventId],
    };

    const tx = kv.atomic();
    tx.check(current);
    tx.set(key, updated);
    await tx.commit();
    return existing.hazard_id;
  }

  // Create new hazard
  const hazardId = crypto.randomUUID();
  const now = new Date().toISOString();
  const hazard: StoredHazard = {
    hazard_id: hazardId,
    latitude: lat,
    longitude: lon,
    first_reported_at: now,
    last_reported_at: now,
    report_count: 1,
    confirm_count: 0,
    reject_count: 0,
    event_ids: [eventId],
  };

  const latBucket = Math.round(lat * 100);
  const lonBucket = Math.round(lon * 100);

  const tx = kv.atomic();
  tx.set(["hazards", hazardId], hazard);
  tx.set(["hazard_geo", latBucket, lonBucket, hazardId], hazardId);
  await tx.commit();

  return hazardId;
}

/** Confirm or reject a known hazard. Returns updated hazard or null if not found. */
export async function confirmHazard(
  hazardId: string,
  confirmation: "confirmed" | "cleared",
): Promise<StoredHazard | null> {
  const key = ["hazards", hazardId];
  const existing = await kv.get<StoredHazard>(key);
  if (!existing.value) return null;

  const updated: StoredHazard = {
    ...existing.value,
    confirm_count: existing.value.confirm_count + (confirmation === "confirmed" ? 1 : 0),
    reject_count: existing.value.reject_count + (confirmation === "cleared" ? 1 : 0),
    last_reported_at: new Date().toISOString(),
  };

  const tx = kv.atomic();
  tx.check(existing);
  tx.set(key, updated);
  const result = await tx.commit();
  return result.ok ? updated : null;
}

/** Find all hazards near a location. */
export async function findHazardsNear(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<StoredHazard[]> {
  const latSpan = Math.ceil(radiusM / 1111) + 1;
  const lonDegreesPerM = 111_320 * Math.cos((lat * Math.PI) / 180);
  const lonSpan = Math.ceil(radiusM / (lonDegreesPerM * 0.01)) + 1;

  const centerLatBucket = Math.round(lat * 100);
  const centerLonBucket = Math.round(lon * 100);

  const hazardIds = new Set<string>();

  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      const entries = kv.list<string>({
        prefix: ["hazard_geo", centerLatBucket + dLat, centerLonBucket + dLon],
      });
      for await (const entry of entries) {
        hazardIds.add(entry.value);
      }
    }
  }

  const hazards: StoredHazard[] = [];
  for (const id of hazardIds) {
    const h = await getHazard(id);
    if (h) hazards.push(h);
  }
  return hazards;
}

/** List up to `limit` hazards, most recently reported first. */
export async function listHazards(limit = 100): Promise<StoredHazard[]> {
  const hazards: StoredHazard[] = [];
  const entries = kv.list<StoredHazard>({ prefix: ["hazards"] });
  for await (const entry of entries) {
    hazards.push(entry.value);
    if (hazards.length >= limit) break;
  }
  hazards.sort((a, b) => new Date(b.last_reported_at).getTime() - new Date(a.last_reported_at).getTime());
  return hazards;
}

/** Check if a dongle has previously reported any event linked to a hazard. */
export async function hasDongleReportedHazard(
  hazard: StoredHazard,
  dongleId: string,
): Promise<boolean> {
  for (const eventId of hazard.event_ids) {
    const event = await getEvent(eventId);
    if (event && event.dongle_id === dongleId) return true;
  }
  return false;
}

// ── Request log ─────────────────────────────────────────────────────

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  query: string;
  status: number;
  duration_ms: number;
  body?: string;
  lat?: number;
  lon?: number;
  bearing?: number;
}

const REQUEST_LOG_MAX = 50;

/** Record an API request. Evicts oldest entries beyond 500. */
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const ts = Date.now();
  const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  await kv.set(["request_log", id], entry);

  // Evict oldest if over limit
  const all: string[] = [];
  const entries = kv.list<RequestLogEntry>({ prefix: ["request_log"] });
  for await (const e of entries) {
    all.push(e.key[1] as string);
  }
  if (all.length > REQUEST_LOG_MAX) {
    all.sort();
    const toDelete = all.slice(0, all.length - REQUEST_LOG_MAX);
    for (const key of toDelete) {
      await kv.delete(["request_log", key]);
    }
  }
}

/** List recent request log entries, newest first. */
export async function listRequestLogs(limit = 50): Promise<RequestLogEntry[]> {
  const logs: { key: string; value: RequestLogEntry }[] = [];
  const entries = kv.list<RequestLogEntry>({ prefix: ["request_log"] });
  for await (const entry of entries) {
    logs.push({ key: entry.key[1] as string, value: entry.value });
  }
  logs.sort((a, b) => b.key.localeCompare(a.key));
  return logs.slice(0, limit).map((l) => l.value);
}

/** Delete all entries from the KV store. */
export async function deleteAll(): Promise<number> {
  let count = 0;
  const entries = kv.list({ prefix: [] });
  for await (const entry of entries) {
    await kv.delete(entry.key);
    count++;
  }
  return count;
}
