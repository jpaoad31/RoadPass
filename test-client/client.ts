#!/usr/bin/env -S deno run --allow-net

/**
 * Interactive test client for the RoadPass hazard server.
 *
 * Usage: deno run --allow-net client.ts [server-url]
 *        Default server URL: http://localhost:8000
 *
 * Commands:
 *   locations                     — List preset locations
 *   report <location> [manual]    — Report a hazard at a preset location
 *   respond <event_id> <yes|no>   — Update response on an event
 *   get <event_id>                — Fetch a single event
 *   ahead <location>              — Query hazards ahead from a location
 *   history                       — Show all events reported this session
 *   help                          — Show this help
 *   quit                          — Exit
 */

const BASE_URL = Deno.args[0] ?? "http://localhost:8000";

// ── Preset locations ────────────────────────────────────────────────
// 3 real locations along Market Street in SF, each ~400m apart, heading east (~65°)
// Plus 2 more on a different road (Mission St) to test filtering

interface PresetLocation {
  name: string;
  description: string;
  lat: number;
  lon: number;
  bearing: number;
  altitude: number;
}

const LOCATIONS: Record<string, PresetLocation> = {
  market1: {
    name: "market1",
    description: "Market St & Castro (SF) — heading east",
    lat: 37.7614,
    lon: -122.4350,
    bearing: 65,
    altitude: 22,
  },
  market2: {
    name: "market2",
    description: "Market St & Church — 400m east of market1",
    lat: 37.7628,
    lon: -122.4292,
    bearing: 65,
    altitude: 18,
  },
  market3: {
    name: "market3",
    description: "Market St & Sanchez — 400m east of market2",
    lat: 37.7642,
    lon: -122.4234,
    bearing: 65,
    altitude: 15,
  },
  mission1: {
    name: "mission1",
    description: "Mission St & 24th (SF) — heading northeast",
    lat: 37.7522,
    lon: -122.4184,
    bearing: 35,
    altitude: 10,
  },
  mission2: {
    name: "mission2",
    description: "Mission St & 22nd — 300m northeast of mission1",
    lat: 37.7551,
    lon: -122.4189,
    bearing: 35,
    altitude: 12,
  },
};

// ── Session state ───────────────────────────────────────────────────

const sessionEvents: { id: string; location: string; time: string }[] = [];
let eventCounter = 0;

// ── Helpers ─────────────────────────────────────────────────────────

function makeEventId(): string {
  return crypto.randomUUID();
}

function makePayload(loc: PresetLocation, triggerSource: "bump_detector" | "manual") {
  const speed = 8 + Math.random() * 10; // 8-18 m/s
  const accel = -(2 + Math.random() * 5); // -2 to -7 m/s²
  return {
    event_id: makeEventId(),
    dongle_id: "test-client-dongle",
    detected_at_ms: Date.now(),
    trigger_source: triggerSource,
    vehicle: {
      speed_ms: round(speed),
      accel_ms2: round(accel),
      yaw_rate_rads: round((Math.random() - 0.5) * 0.1),
      steering_angle_deg: round((Math.random() - 0.5) * 10),
      brake_pressed: Math.random() > 0.5,
      gear: "drive",
      wheel_speeds: {
        fl: round(speed + (Math.random() - 0.5) * 0.5),
        fr: round(speed + (Math.random() - 0.5) * 0.5),
        rl: round(speed + (Math.random() - 0.5) * 0.5),
        rr: round(speed + (Math.random() - 0.5) * 0.5),
      },
    },
    location: {
      latitude: loc.lat,
      longitude: loc.lon,
      altitude_m: loc.altitude,
      bearing_deg: loc.bearing,
      speed_ms: round(speed + (Math.random() - 0.5)),
      horizontal_accuracy_m: round(2 + Math.random() * 5),
      has_fix: true,
      satellite_count: 7 + Math.floor(Math.random() * 6),
      gps_timestamp_ms: Date.now(),
    },
    openpilot: {
      engaged: Math.random() > 0.3,
      state: "enabled",
      experimental_mode: false,
    },
    driver: {
      face_detected: true,
      is_distracted: Math.random() > 0.8,
      awareness_status: round(0.6 + Math.random() * 0.4),
    },
  };
}

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

async function doFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, options);
    const body = await res.json();
    if (!res.ok) {
      console.log(`  ✗ ${res.status}: ${JSON.stringify(body)}`);
      return null;
    }
    return body;
  } catch (e) {
    console.log(`  ✗ Connection failed: ${(e as Error).message}`);
    return null;
  }
}

// ── Commands ────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
Commands:
  locations                     List preset test locations
  report <location> [manual]    Report a hazard (default: bump_detector)
  respond <event_id> <yes|no>   Send a response for an event
  get <event_id>                Fetch a single event by ID
  ahead <location> [radius_m]   Query hazards ahead from a location
  history                       Show events reported this session
  seed                          Report one event at each of the 5 locations
  reset                         Delete everything in the database
  help                          Show this help
  quit / exit                   Exit the client
`);
}

function cmdLocations() {
  console.log("\nPreset locations:");
  for (const [key, loc] of Object.entries(LOCATIONS)) {
    console.log(`  ${key.padEnd(12)} ${loc.description}`);
    console.log(`${"".padEnd(15)}(${loc.lat}, ${loc.lon}) bearing ${loc.bearing}°`);
  }
  console.log();
}

async function cmdReport(locName: string, manual: boolean) {
  const loc = LOCATIONS[locName];
  if (!loc) {
    console.log(`  Unknown location "${locName}". Use 'locations' to see options.`);
    return;
  }

  const trigger = manual ? "manual" as const : "bump_detector" as const;
  const payload = makePayload(loc, trigger);
  console.log(`  Reporting ${trigger} at ${loc.description}`);
  console.log(`  Event ID: ${payload.event_id}`);
  console.log(`  Speed: ${payload.vehicle.speed_ms} m/s, Accel: ${payload.vehicle.accel_ms2} m/s²`);

  const result = await doFetch("/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (result) {
    console.log(`  ✓ Created`);
    sessionEvents.push({
      id: payload.event_id,
      location: locName,
      time: new Date().toLocaleTimeString(),
    });
    eventCounter++;
  }
}

async function cmdRespond(eventId: string, answer: string) {
  if (!["yes", "no", "timeout"].includes(answer)) {
    console.log(`  Answer must be "yes", "no", or "timeout"`);
    return;
  }

  const latency = round(1 + Math.random() * 10);
  console.log(`  Responding "${answer}" to ${eventId} (latency: ${latency}s)`);

  const result = await doFetch("/events/response", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      response: answer,
      response_latency_s: latency,
    }),
  });

  if (result) {
    console.log(`  ✓ Updated`);
  }
}

async function cmdGet(eventId: string) {
  // Allow shorthand: if just a number, look up from session history
  let resolvedId = eventId;
  const idx = parseInt(eventId);
  if (!isNaN(idx) && idx >= 0 && idx < sessionEvents.length) {
    resolvedId = sessionEvents[idx].id;
    console.log(`  Resolving #${idx} → ${resolvedId}`);
  }

  const result = await doFetch(`/events/${resolvedId}`);
  if (result) {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function cmdAhead(locName: string, radiusM?: number) {
  const loc = LOCATIONS[locName];
  if (!loc) {
    console.log(`  Unknown location "${locName}". Use 'locations' to see options.`);
    return;
  }

  const params = new URLSearchParams({
    lat: String(loc.lat),
    lon: String(loc.lon),
    bearing: String(loc.bearing),
  });
  if (radiusM) params.set("radius_m", String(radiusM));

  console.log(`  Querying hazards ahead from ${loc.description}`);
  console.log(`  Bearing: ${loc.bearing}°, Radius: ${radiusM ?? 1609}m`);

  const result = await doFetch(`/hazards/ahead?${params}`) as {
    road: { road_name: string | null; osm_way_id: string | null; road_ref: string | null };
    hazards: { event_id: string; distance_m: number; bearing_deg: number; accel_ms2: number; response_summary: { yes_count: number; no_count: number; total_reports: number } }[];
  } | null;

  if (result) {
    console.log(`\n  Road: ${result.road?.road_name ?? "unknown"} (OSM way ${result.road?.osm_way_id ?? "?"}, ref: ${result.road?.road_ref ?? "none"})`);
    if (result.hazards.length === 0) {
      console.log("  No hazards ahead.");
    } else {
      console.log(`  ${result.hazards.length} hazard(s) ahead:\n`);
      for (const h of result.hazards) {
        const conf = `${h.response_summary.yes_count}y/${h.response_summary.no_count}n of ${h.response_summary.total_reports}`;
        console.log(`    ${h.distance_m}m away @ ${h.bearing_deg}° | accel: ${h.accel_ms2} m/s² | responses: ${conf}`);
        console.log(`    id: ${h.event_id}`);
      }
    }
    console.log();
  }
}

function cmdHistory() {
  if (sessionEvents.length === 0) {
    console.log("  No events reported this session.");
    return;
  }
  console.log("\n  # | Location    | Time     | Event ID");
  console.log("  --|-------------|----------|" + "-".repeat(38));
  for (let i = 0; i < sessionEvents.length; i++) {
    const e = sessionEvents[i];
    console.log(`  ${String(i).padEnd(2)}| ${e.location.padEnd(12)}| ${e.time.padEnd(9)}| ${e.id}`);
  }
  console.log(`\n  Tip: use 'get <#>' to fetch by index, or 'respond <id> yes' to respond.`);
  console.log();
}

async function cmdSeed() {
  console.log("  Seeding one event at each location...\n");
  for (const locName of Object.keys(LOCATIONS)) {
    await cmdReport(locName, false);
    console.log();
  }
  console.log("  Done. Use 'history' to see all events, 'ahead <location>' to query.");
}

async function cmdReset() {
  const result = await doFetch("/events", { method: "DELETE" }) as { count?: number } | null;
  if (result) {
    console.log(`  ✓ Deleted ${result.count ?? 0} entries from the database.`);
    sessionEvents.length = 0;
    eventCounter = 0;
  }
}

// ── REPL ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  RoadPass Test Client`);
  console.log(`  Server: ${BASE_URL}`);

  // Quick health check
  const health = await doFetch("/health");
  if (health) {
    console.log(`  Server status: ok`);
  } else {
    console.log(`  Warning: server not reachable at ${BASE_URL}`);
  }

  console.log(`  Type 'help' for commands.\n`);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = new Uint8Array(1024);

  while (true) {
    await Deno.stdout.write(encoder.encode("roadpass> "));
    const n = await Deno.stdin.read(buf);
    if (n === null) break; // EOF

    const line = decoder.decode(buf.subarray(0, n)).trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    try {
      switch (cmd) {
        case "help":
        case "?":
          cmdHelp();
          break;
        case "locations":
        case "locs":
          cmdLocations();
          break;
        case "report":
        case "r":
          await cmdReport(parts[1] ?? "", parts[2] === "manual");
          break;
        case "respond":
        case "res":
          await cmdRespond(parts[1] ?? "", parts[2] ?? "");
          break;
        case "get":
        case "g":
          await cmdGet(parts[1] ?? "");
          break;
        case "ahead":
        case "a":
          await cmdAhead(parts[1] ?? "", parts[2] ? parseFloat(parts[2]) : undefined);
          break;
        case "history":
        case "h":
          cmdHistory();
          break;
        case "seed":
        case "s":
          await cmdSeed();
          break;
        case "reset":
          await cmdReset();
          break;
        case "quit":
        case "exit":
        case "q":
          console.log("  Bye!");
          Deno.exit(0);
          break;
        default:
          console.log(`  Unknown command: "${cmd}". Type 'help' for options.`);
      }
    } catch (e) {
      console.log(`  Error: ${(e as Error).message}`);
    }
  }
}

main();
