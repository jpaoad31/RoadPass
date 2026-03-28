import { haversineDistance, bearingBetween, bearingDifference } from "./geo.ts";
import { reverseGeocode } from "./nominatim.ts";
import { createEvent, updateResponse, getEvent, findEventsNear, listEvents, deleteAll } from "./storage.ts";
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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function handleDashboard(): Promise<Response> {
  const events = await listEvents(100);

  const rows = events.map((e) => {
    const time = new Date(e.detected_at_ms).toISOString().replace("T", " ").slice(0, 19);
    const response = e.response
      ? `${e.response.answer} (${e.response.latency_s}s)`
      : "pending";
    return `<tr>
      <td title="${esc(e.event_id)}">${esc(e.event_id.slice(0, 8))}...</td>
      <td>${esc(e.dongle_id)}</td>
      <td>${time}</td>
      <td>${esc(e.trigger_source)}</td>
      <td>${e.location.latitude.toFixed(5)}, ${e.location.longitude.toFixed(5)}</td>
      <td>${e.vehicle.speed_ms.toFixed(1)}</td>
      <td>${e.vehicle.accel_ms2.toFixed(1)}</td>
      <td>${e.location.bearing_deg.toFixed(0)}</td>
      <td>${e.vehicle.brake_pressed ? "yes" : "no"}</td>
      <td>${response}</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RoadPass - Hazard Events</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; }
    h1 { color: #333; }
    .count { color: #666; font-weight: normal; font-size: 0.6em; }
    table { border-collapse: collapse; width: 100%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.85rem; }
    th { background: #333; color: white; position: sticky; top: 0; }
    tr:hover { background: #f0f7ff; }
    td:nth-child(6), td:nth-child(7) { font-variant-numeric: tabular-nums; }
    .empty { text-align: center; padding: 3rem; color: #999; }
  </style>
</head>
<body>
  <h1>Hazard Events <span class="count">(${events.length} event${events.length !== 1 ? "s" : ""})</span></h1>
  ${events.length === 0
    ? '<div class="empty">No events recorded yet.</div>'
    : `<table>
    <thead><tr>
      <th>ID</th><th>Dongle</th><th>Detected</th><th>Trigger</th>
      <th>Location</th><th>Speed (m/s)</th><th>Accel (m/s2)</th>
      <th>Bearing</th><th>Brake</th><th>Response</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

  if (req.method === "GET" && path === "/") {
    return handleDashboard();
  }

  if (req.method === "GET" && path === "/about") {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RoadPass - About</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; }
    h1 { color: #333; }
    p { color: #555; font-size: 1.1rem; }
  </style>
</head>
<body>
  <h1>Made By:</h1>
  <p>Swetha Shankar and John Adams</p>
</body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (req.method === "DELETE" && path === "/events") {
    return deleteAll().then((count) => json({ status: "deleted", count }));
  }

  if (req.method === "GET" && path === "/health") {
    return json({ status: "ok" });
  }

  return err("Not found", 404);
}

export default {
  fetch: route,
} satisfies Deno.ServeDefaultExport;
