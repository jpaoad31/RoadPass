import type { StoredHazardEvent } from "./types.ts";

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

const REQUEST_LOG_MAX = 500;

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
export async function listRequestLogs(limit = 500): Promise<RequestLogEntry[]> {
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
