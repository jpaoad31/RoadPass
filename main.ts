import { haversineDistance, bearingBetween, bearingDifference } from "./geo.ts";
import { reverseGeocode } from "./nominatim.ts";
import { createEvent, updateResponse, getEvent, listEvents, deleteAll, logRequest, listRequestLogs, upsertHazardForEvent, confirmHazard, findHazardsNear, getHazard, listHazards } from "./storage.ts";
import type {
  HazardEventPayload,
  HazardConfirmation,
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

  // Upsert aggregated hazard — link this event to an existing hazard or create a new one
  const hazardId = await upsertHazardForEvent(
    body.event_id,
    body.location.latitude,
    body.location.longitude,
  );

  return json({ status: "created", event_id: body.event_id, hazard_id: hazardId }, 201);
}

async function handleUpdateResponse(req: Request): Promise<Response> {
  const body = await req.json() as ResponseUpdate;

  if (!body.event_id || !body.response) {
    return err("Missing required fields: event_id, response", 400);
  }

  const updated = await updateResponse(body.event_id, body.response, body.response_latency_s ?? 0);
  if (!updated) {
    return err("Event not found or write conflict", 404);
  }

  return json({ status: "updated", event_id: body.event_id });
}

async function handleConfirmHazard(req: Request): Promise<Response> {
  const body = await req.json() as HazardConfirmation;

  if (!body.hazard_id || !body.confirmation) {
    return err("Missing required fields: hazard_id, confirmation", 400);
  }

  if (body.confirmation !== "confirmed" && body.confirmation !== "cleared") {
    return err('confirmation must be "confirmed" or "cleared"', 400);
  }

  const updated = await confirmHazard(body.hazard_id, body.confirmation);
  if (!updated) {
    return err("Hazard not found", 404);
  }

  return json({
    status: "updated",
    hazard_id: body.hazard_id,
    confirm_count: updated.confirm_count,
    reject_count: updated.reject_count,
  });
}

async function handleGetHazard(hazardId: string): Promise<Response> {
  const hazard = await getHazard(hazardId);
  if (!hazard) return err("Not found", 404);
  return json(hazard);
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

  // 1. Find aggregated hazards within the search radius
  const nearby = await findHazardsNear(lat, lon, radiusM);

  // 2. Filter to hazards that are roughly "ahead" (within 90° of heading)
  const ahead = nearby.filter((h) => {
    const toBearing = bearingBetween(lat, lon, h.latitude, h.longitude);
    return bearingDifference(bearing, toBearing) < 90;
  });

  // 3. Reverse geocode to get road info
  const road = await reverseGeocode(lat, lon);

  // 4. Build response
  const hazards: HazardAhead[] = ahead.map((h) => {
    const dist = haversineDistance(lat, lon, h.latitude, h.longitude);
    return {
      hazard_id: h.hazard_id,
      latitude: h.latitude,
      longitude: h.longitude,
      distance_m: Math.round(dist),
      bearing_deg: Math.round(bearingBetween(lat, lon, h.latitude, h.longitude)),
      report_count: h.report_count,
      confirm_count: h.confirm_count,
      reject_count: h.reject_count,
      first_reported_at: h.first_reported_at,
      last_reported_at: h.last_reported_at,
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

async function handleMap(): Promise<Response> {
  const hazards = await listHazards(100);

  const markers = hazards.map((h) => {
    const total = h.confirm_count + h.reject_count;
    const confirmRatio = total > 0 ? h.confirm_count / total : 0;
    // Color by confidence: high confirms = red (danger), high clears = grey, no data = orange
    let color: string;
    let status: string;
    if (total === 0) {
      color = "#f39c12"; // orange — reports only, no confirmations yet
      status = "unverified";
    } else if (confirmRatio >= 0.5) {
      color = "#e74c3c"; // red — mostly confirmed
      status = "confirmed";
    } else {
      color = "#95a5a6"; // grey — mostly cleared
      status = "cleared";
    }

    // Scale radius by report count (min 6, max 16)
    const radius = Math.min(16, Math.max(6, 4 + h.report_count * 2));

    const lastTime = h.last_reported_at.replace("T", " ").slice(0, 19);
    const popup = `<b>Hazard</b><br>` +
      `Reports: ${h.report_count}<br>` +
      `Confirmed: ${h.confirm_count} | Cleared: ${h.reject_count}<br>` +
      `Last: ${lastTime}<br>` +
      `Events: ${h.event_ids.length}<br>` +
      `<small>${esc(h.hazard_id)}</small>`;

    return { lat: h.latitude, lon: h.longitude, color, popup, status, radius };
  });

  const markersJson = JSON.stringify(markers);

  const centerLat = hazards.length > 0 ? hazards[0].latitude : 37.77;
  const centerLon = hazards.length > 0 ? hazards[0].longitude : -122.42;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RoadPass - Hazard Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    #header { background: #333; color: white; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; }
    #header h1 { margin: 0; font-size: 1.1rem; }
    #header .count { color: #aaa; font-size: 0.85rem; }
    #header a { color: #7cb9e8; text-decoration: none; font-size: 0.85rem; }
    #map { height: calc(100vh - 48px); }
    .legend { background: white; padding: 8px 12px; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); line-height: 1.8; }
    .legend i { width: 12px; height: 12px; display: inline-block; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Hazard Map</h1>
    <span class="count">${hazards.length} hazard${hazards.length !== 1 ? "s" : ""}</span>
    <a href="/">Table View</a>
    <a href="/about">About</a>
  </div>
  <div id="map"></div>
  <script>
    const markers = ${markersJson};
    const map = L.map('map').setView([${centerLat}, ${centerLon}], 14);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    var confirmedLayer = L.layerGroup().addTo(map);
    var unverifiedLayer = L.layerGroup().addTo(map);
    var clearedLayer = L.layerGroup().addTo(map);

    var layerMap = {
      'confirmed': confirmedLayer,
      'unverified': unverifiedLayer,
      'cleared': clearedLayer
    };

    markers.forEach(function(m) {
      var target = layerMap[m.status] || unverifiedLayer;
      L.circleMarker([m.lat, m.lon], {
        radius: m.radius,
        fillColor: m.color,
        color: '#333',
        weight: 1,
        fillOpacity: 0.85
      }).addTo(target).bindPopup(m.popup);
    });

    // Fit bounds if we have markers
    if (markers.length > 0) {
      var bounds = L.latLngBounds(markers.map(function(m) { return [m.lat, m.lon]; }));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }

    // Layer control
    var overlays = {};
    overlays['<i style="background:#e74c3c;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Confirmed'] = confirmedLayer;
    overlays['<i style="background:#f39c12;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Unverified'] = unverifiedLayer;
    overlays['<i style="background:#95a5a6;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Cleared'] = clearedLayer;

    L.control.layers(null, overlays, { collapsed: false, position: 'topright' }).addTo(map);
  <\/script>
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

  if (req.method === "POST" && path === "/hazards/confirm") {
    return handleConfirmHazard(req);
  }

  if (req.method === "GET" && path.startsWith("/hazards/") && !path.includes("/ahead")) {
    const id = path.slice("/hazards/".length);
    if (id && !id.includes("/")) return handleGetHazard(id);
  }

  if (req.method === "GET" && path === "/") {
    return handleDashboard();
  }

  if (req.method === "GET" && path === "/map") {
    return handleMap();
  }

  if (req.method === "GET" && path === "/requests") {
    return handleRequestLog();
  }

  if (req.method === "GET" && path === "/requests/map") {
    return handleRequestMap();
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

// Skip logging for these paths to avoid noise / recursive logging
const SKIP_LOG_PATHS = new Set(["/", "/map", "/about", "/requests", "/requests/map", "/health"]);

async function loggedRoute(req: Request): Promise<Response> {
  const start = performance.now();
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;
  const query = url.search;

  // Clone the request body for logging if it's a mutation endpoint
  let bodyPreview = "";
  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    try {
      const cloned = req.clone();
      const text = await cloned.text();
      bodyPreview = text.length > 500 ? text.slice(0, 500) + "..." : text;
    } catch { /* no body */ }
  }

  let res: Response;
  try {
    const result = route(req);
    res = result instanceof Promise ? await result : result;
  } catch (e) {
    const ms = (performance.now() - start).toFixed(1);
    console.error(`[${new Date().toISOString()}] ${method} ${path}${query} => 500 (${ms}ms) ERROR: ${e}`);
    throw e;
  }

  const durationMs = parseFloat((performance.now() - start).toFixed(1));
  const logParts = [
    `[${new Date().toISOString()}]`,
    `${method} ${path}${query}`,
    `=> ${res.status}`,
    `(${durationMs}ms)`,
  ];

  if (bodyPreview) {
    logParts.push(`body: ${bodyPreview}`);
  }

  console.log(logParts.join(" "));

  // Persist to KV for API endpoints (skip HTML pages to reduce noise)
  if (!SKIP_LOG_PATHS.has(path)) {
    // Extract location from query params if present (for /hazards/ahead)
    const latParam = parseFloat(url.searchParams.get("lat") ?? "");
    const lonParam = parseFloat(url.searchParams.get("lon") ?? "");
    const bearingParam = parseFloat(url.searchParams.get("bearing") ?? "");

    // Also extract location from POST body for /events
    let bodyLat: number | undefined;
    let bodyLon: number | undefined;
    let bodyBearing: number | undefined;
    if (bodyPreview && (path === "/events")) {
      try {
        const parsed = JSON.parse(bodyPreview.replace(/\.\.\.$/, ""));
        bodyLat = parsed?.location?.latitude;
        bodyLon = parsed?.location?.longitude;
        bodyBearing = parsed?.location?.bearing_deg;
      } catch { /* ignore parse errors on truncated bodies */ }
    }

    logRequest({
      timestamp: new Date().toISOString(),
      method,
      path,
      query,
      status: res.status,
      duration_ms: durationMs,
      body: bodyPreview || undefined,
      lat: !isNaN(latParam) ? latParam : bodyLat,
      lon: !isNaN(lonParam) ? lonParam : bodyLon,
      bearing: !isNaN(bearingParam) ? bearingParam : bodyBearing,
    }).catch(() => {}); // fire-and-forget, don't block the response
  }

  return res;
}

async function handleRequestLog(): Promise<Response> {
  const logs = await listRequestLogs(500);

  const rows = logs.map((l) => {
    const time = l.timestamp.replace("T", " ").slice(0, 23);
    const statusClass = l.status >= 400 ? "err" : "ok";
    const bodyCell = l.body
      ? `<td class="body" title="${esc(l.body)}">${esc(l.body.slice(0, 80))}${l.body.length > 80 ? "..." : ""}</td>`
      : `<td class="body muted">-</td>`;
    return `<tr>
      <td>${time}</td>
      <td><span class="method">${l.method}</span></td>
      <td>${esc(l.path)}${esc(l.query)}</td>
      <td class="${statusClass}">${l.status}</td>
      <td>${l.duration_ms}ms</td>
      ${bodyCell}
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RoadPass - Request Log</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; }
    h1 { color: #333; }
    .count { color: #666; font-weight: normal; font-size: 0.6em; }
    table { border-collapse: collapse; width: 100%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.85rem; }
    th { background: #333; color: white; position: sticky; top: 0; }
    tr:hover { background: #f0f7ff; }
    .method { font-weight: 600; }
    .ok { color: #27ae60; }
    .err { color: #e74c3c; }
    .body { font-family: monospace; font-size: 0.75rem; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #ccc; }
    .empty { text-align: center; padding: 3rem; color: #999; }
    nav { margin-bottom: 1rem; }
    nav a { color: #2980b9; margin-right: 1rem; text-decoration: none; font-size: 0.9rem; }
  </style>
</head>
<body>
  <nav><a href="/">Events</a> <a href="/map">Map</a> <a href="/requests">Request Log</a> <a href="/about">About</a></nav>
  <h1>Request Log <span class="count">(${logs.length} entries, max 500)</span></h1>
  ${logs.length === 0
    ? '<div class="empty">No API requests logged yet.</div>'
    : `<table>
    <thead><tr>
      <th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Body</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleRequestMap(): Promise<Response> {
  const logs = await listRequestLogs(500);

  // Only include entries that have location data
  const geoLogs = logs.filter((l) => l.lat != null && l.lon != null);

  // Group by method+path to color differently (GET /hazards/ahead vs POST /events etc)
  const points = geoLogs.map((l) => {
    const time = l.timestamp.replace("T", " ").slice(0, 23);
    let color: string;
    let label: string;
    if (l.method === "GET" && l.path === "/hazards/ahead") {
      color = "#2980b9"; // blue for query requests
      label = "Query";
    } else if (l.method === "POST" && l.path === "/events") {
      color = "#e74c3c"; // red for event reports
      label = "Report";
    } else if (l.method === "PATCH") {
      color = "#f39c12"; // orange for responses
      label = "Response";
    } else {
      color = "#95a5a6"; // grey for other
      label = l.method;
    }
    return {
      lat: l.lat!,
      lon: l.lon!,
      bearing: l.bearing ?? null,
      color,
      label,
      time,
      path: l.path,
      status: l.status,
    };
  });

  // Build route lines: connect sequential GET /hazards/ahead points (device route)
  const queryPoints = points
    .filter((p) => p.label === "Query")
    .reverse(); // oldest first for route drawing

  const pointsJson = JSON.stringify(points);
  const routeJson = JSON.stringify(queryPoints.map((p) => [p.lat, p.lon]));

  const centerLat = geoLogs.length > 0 ? geoLogs[0].lat! : 37.77;
  const centerLon = geoLogs.length > 0 ? geoLogs[0].lon! : -122.42;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RoadPass - Request Map</title>
  <meta http-equiv="refresh" content="10">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    #header { background: #333; color: white; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; }
    #header h1 { margin: 0; font-size: 1.1rem; }
    #header .count { color: #aaa; font-size: 0.85rem; }
    #header a { color: #7cb9e8; text-decoration: none; font-size: 0.85rem; }
    #map { height: calc(100vh - 48px); }
    .legend { background: white; padding: 8px 12px; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); line-height: 1.8; font-size: 0.85rem; }
    .legend i { width: 12px; height: 12px; display: inline-block; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Request Map</h1>
    <span class="count">${geoLogs.length} located request${geoLogs.length !== 1 ? "s" : ""} (${queryPoints.length} route point${queryPoints.length !== 1 ? "s" : ""})</span>
    <a href="/">Events</a>
    <a href="/map">Hazard Map</a>
    <a href="/requests">Request Log</a>
    <a href="/about">About</a>
  </div>
  <div id="map"></div>
  <script>
    const points = ${pointsJson};
    const routeCoords = ${routeJson};
    const map = L.map('map').setView([${centerLat}, ${centerLon}], 14);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Layer groups for toggling
    var queryLayer = L.layerGroup().addTo(map);
    var reportLayer = L.layerGroup().addTo(map);
    var responseLayer = L.layerGroup().addTo(map);
    var routeLayer = L.layerGroup().addTo(map);
    var arrowLayer = L.layerGroup().addTo(map);

    var layerMap = {
      'Query': queryLayer,
      'Report': reportLayer,
      'Response': responseLayer
    };

    // Draw route line connecting query points
    if (routeCoords.length > 1) {
      L.polyline(routeCoords, {
        color: '#2980b9',
        weight: 3,
        opacity: 0.5,
        dashArray: '8, 6'
      }).addTo(routeLayer);
    }

    function arrowIcon(bearing, color) {
      return L.divIcon({
        className: '',
        html: '<div style="transform:rotate(' + bearing + 'deg);color:' + color + ';font-size:32px;font-weight:bold;line-height:1;text-align:center;margin-top:-16px;margin-left:-10px;text-shadow:0 0 3px #fff, 0 0 5px #fff;">&#x25B2;</div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
    }

    points.forEach(function(p) {
      var targetLayer = layerMap[p.label] || queryLayer;

      var marker = L.circleMarker([p.lat, p.lon], {
        radius: 6,
        fillColor: p.color,
        color: '#333',
        weight: 1,
        fillOpacity: 0.85
      }).addTo(targetLayer);

      var popup = '<b>' + p.label + '</b> ' + p.path + '<br>' +
        p.time + '<br>' +
        'Status: ' + p.status + '<br>' +
        p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) +
        (p.bearing != null ? '<br>Bearing: ' + p.bearing + '&deg;' : '');
      marker.bindPopup(popup);

      if (p.bearing != null && p.label === 'Query') {
        L.marker([p.lat, p.lon], { icon: arrowIcon(p.bearing, p.color) })
          .addTo(arrowLayer);
      }
    });

    // Fit bounds
    if (points.length > 0) {
      var bounds = L.latLngBounds(points.map(function(p) { return [p.lat, p.lon]; }));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }

    // Layer control
    var overlays = {};
    overlays['<i style="background:#2980b9;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Hazard queries'] = queryLayer;
    overlays['<i style="background:#e74c3c;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Event reports'] = reportLayer;
    overlays['<i style="background:#f39c12;width:10px;height:10px;display:inline-block;border-radius:50%;margin-right:4px"></i> Response updates'] = responseLayer;
    overlays['<span style="color:#2980b9">- - -</span> Device route'] = routeLayer;
    overlays['&#x25B2; Bearing arrows'] = arrowLayer;

    L.control.layers(null, overlays, { collapsed: false, position: 'topright' }).addTo(map);
  <\/script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export default {
  fetch: loggedRoute,
} satisfies Deno.ServeDefaultExport;
