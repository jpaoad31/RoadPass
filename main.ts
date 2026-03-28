import { haversineDistance, bearingBetween, bearingDifference } from "./geo.ts";
import { reverseGeocode } from "./nominatim.ts";
import { createEvent, updateResponse, getEvent, findEventsNear } from "./storage.ts";
import type {
  HazardEventPayload,
  ResponseUpdate,
  StoredHazardEvent,
  HazardAhead,
  HazardsAheadResponse,
} from "./types.ts";

const MILE_M = 1609;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Aggregate response stats for hazards at roughly the same location */
function summarizeResponses(
  events: StoredHazardEvent[],
  clusterRadiusM = 50,
): Map<string, { yes: number; no: number; total: number }> {
  const clusters: { center: { lat: number; lon: number }; eventIds: string[]; yes: number; no: number; total: number }[] = [];

  for (const e of events) {
    const eLat = e.location.latitude;
    const eLon = e.location.longitude;
    let placed = false;

    for (const c of clusters) {
      if (haversineDistance(c.center.lat, c.center.lon, eLat, eLon) <= clusterRadiusM) {
        c.eventIds.push(e.event_id);
        c.total++;
        if (e.response?.answer === "yes") c.yes++;
        if (e.response?.answer === "no") c.no++;
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({
        center: { lat: eLat, lon: eLon },
        eventIds: [e.event_id],
        total: 1,
        yes: e.response?.answer === "yes" ? 1 : 0,
        no: e.response?.answer === "no" ? 1 : 0,
      });
    }
  }

  const summary = new Map<string, { yes: number; no: number; total: number }>();
  for (const c of clusters) {
    const stats = { yes: c.yes, no: c.no, total: c.total };
    for (const id of c.eventIds) {
      summary.set(id, stats);
    }
  }
  return summary;
}

async function handleReportEvent(req: Request): Promise<Response> {
  const body = await req.json() as HazardEventPayload;

  if (!body.event_id || !body.dongle_id || !body.location) {
    return err("Missing required fields: event_id, dongle_id, location", 400);
  }

  const stored: StoredHazardEvent = {
    ...body,
    created_at: new Date().toISOString(),
  };

  const ok = await createEvent(stored);
  if (!ok) {
    return err("Event already exists or write conflict", 409);
  }

  return json({ status: "created", event_id: body.event_id }, 201);
}

async function handleUpdateResponse(req: Request): Promise<Response> {
  const body = await req.json() as ResponseUpdate;

  if (!body.event_id || !body.answer) {
    return err("Missing required fields: event_id, answer", 400);
  }

  const updated = await updateResponse(body.event_id, body.answer, body.latency_s ?? 0);
  if (!updated) {
    return err("Event not found or write conflict", 404);
  }

  return json({ status: "updated", event_id: body.event_id });
}

async function handleGetEvent(eventId: string): Promise<Response> {
  const event = await getEvent(eventId);
  if (!event) return err("Not found", 404);
  return json(event);
}

async function handleHazardsAhead(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat") ?? "");
  const lon = parseFloat(url.searchParams.get("lon") ?? "");
  const bearing = parseFloat(url.searchParams.get("bearing") ?? "");

  if (isNaN(lat) || isNaN(lon) || isNaN(bearing)) {
    return err("Required query params: lat, lon, bearing (all numeric)", 400);
  }

  const radiusM = parseFloat(url.searchParams.get("radius_m") ?? String(MILE_M));

  // 1. Find all events within the search radius
  const nearby = await findEventsNear(lat, lon, radiusM);

  // 2. Filter to events that are roughly "ahead" (within 90° of heading)
  const ahead = nearby.filter((e) => {
    const toBearing = bearingBetween(lat, lon, e.location.latitude, e.location.longitude);
    return bearingDifference(bearing, toBearing) < 90;
  });

  // 3. Build response summaries (cluster nearby reports)
  const summaries = summarizeResponses(ahead);

  // 4. Reverse geocode to get road info
  const road = await reverseGeocode(lat, lon);

  // 5. Build response
  const hazards: HazardAhead[] = ahead.map((e) => {
    const dist = haversineDistance(lat, lon, e.location.latitude, e.location.longitude);
    const stats = summaries.get(e.event_id) ?? { yes: 0, no: 0, total: 1 };
    return {
      event_id: e.event_id,
      latitude: e.location.latitude,
      longitude: e.location.longitude,
      distance_m: Math.round(dist),
      bearing_deg: Math.round(bearingBetween(lat, lon, e.location.latitude, e.location.longitude)),
      trigger_source: e.trigger_source,
      detected_at_ms: e.detected_at_ms,
      accel_ms2: e.vehicle.accel_ms2,
      response_summary: {
        yes_count: stats.yes,
        no_count: stats.no,
        total_reports: stats.total,
      },
    };
  });

  hazards.sort((a, b) => a.distance_m - b.distance_m);

  const result: HazardsAheadResponse = { road, hazards };
  return json(result);
}

function route(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "POST" && path === "/events") {
    return handleReportEvent(req);
  }

  if (req.method === "PATCH" && path === "/events/response") {
    return handleUpdateResponse(req);
  }

  if (req.method === "GET" && path.startsWith("/events/")) {
    const id = path.slice("/events/".length);
    if (id && !id.includes("/")) return handleGetEvent(id);
  }

  if (req.method === "GET" && path === "/hazards/ahead") {
    return handleHazardsAhead(req);
  }

  if (req.method === "GET" && path === "/health") {
    return json({ status: "ok" });
  }

  return err("Not found", 404);
}

export default {
  fetch: route,
} satisfies Deno.ServeDefaultExport;
