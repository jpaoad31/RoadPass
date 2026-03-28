import { assertEquals, assertAlmostEquals } from "@std/assert";
import { haversineDistance, bearingBetween, bearingDifference } from "./geo.ts";

Deno.test("haversineDistance - known distance SF to Oakland", () => {
  // SF (37.7749, -122.4194) to Oakland (37.8044, -122.2712)
  const dist = haversineDistance(37.7749, -122.4194, 37.8044, -122.2712);
  // Should be roughly 13.1 km
  assertAlmostEquals(dist, 13_100, 500);
});

Deno.test("haversineDistance - same point is zero", () => {
  assertEquals(haversineDistance(37.7749, -122.4194, 37.7749, -122.4194), 0);
});

Deno.test("bearingBetween - due east", () => {
  const b = bearingBetween(0, 0, 0, 1);
  assertAlmostEquals(b, 90, 0.1);
});

Deno.test("bearingBetween - due north", () => {
  const b = bearingBetween(0, 0, 1, 0);
  assertAlmostEquals(b, 0, 0.1);
});

Deno.test("bearingDifference - same bearing", () => {
  assertEquals(bearingDifference(90, 90), 0);
});

Deno.test("bearingDifference - opposite", () => {
  assertEquals(bearingDifference(0, 180), 180);
});

Deno.test("bearingDifference - wraps around", () => {
  assertAlmostEquals(bearingDifference(350, 10), 20, 0.01);
});

Deno.test({ name: "server health check", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (await import("./main.ts")).default.fetch);
  const addr = server.addr;
  const res = await fetch(`http://localhost:${addr.port}/health`);
  const body = await res.json();
  assertEquals(body.status, "ok");
  await server.shutdown();
}});

Deno.test({ name: "POST /events and GET /events/:id round-trip", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (await import("./main.ts")).default.fetch);
  const addr = server.addr;
  const base = `http://localhost:${addr.port}`;

  const payload = {
    event_id: `test-${crypto.randomUUID()}`,
    dongle_id: "test-dongle",
    detected_at_ms: Date.now(),
    trigger_source: "bump_detector",
    vehicle: {
      speed_ms: 12.4, accel_ms2: -4.7, yaw_rate_rads: 0.02,
      steering_angle_deg: -3.1, brake_pressed: false, gear: "drive",
      wheel_speeds: { fl: 12.3, fr: 12.4, rl: 12.2, rr: 12.5 },
    },
    location: {
      latitude: 37.7749, longitude: -122.4194, altitude_m: 15.2,
      bearing_deg: 270, speed_ms: 12.3, horizontal_accuracy_m: 3.1,
      has_fix: true, satellite_count: 9, gps_timestamp_ms: Date.now(),
    },
    openpilot: { engaged: true, state: "enabled", experimental_mode: false },
    driver: { face_detected: true, is_distracted: false, awareness_status: 0.87 },
  };

  // Create
  const createRes = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assertEquals(createRes.status, 201);
  await createRes.text();

  // Read back
  const getRes = await fetch(`${base}/events/${payload.event_id}`);
  assertEquals(getRes.status, 200);
  const stored = await getRes.json();
  assertEquals(stored.event_id, payload.event_id);
  assertEquals(stored.dongle_id, "test-dongle");
  assertEquals(typeof stored.created_at, "string");

  await server.shutdown();
}});

Deno.test({ name: "PATCH /events/response updates event", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (await import("./main.ts")).default.fetch);
  const addr = server.addr;
  const base = `http://localhost:${addr.port}`;

  const eventId = `test-${crypto.randomUUID()}`;
  const payload = {
    event_id: eventId,
    dongle_id: "test-dongle-2",
    detected_at_ms: Date.now(),
    trigger_source: "manual",
    vehicle: {
      speed_ms: 5, accel_ms2: -2, yaw_rate_rads: 0,
      steering_angle_deg: 0, brake_pressed: true, gear: "drive",
      wheel_speeds: { fl: 5, fr: 5, rl: 5, rr: 5 },
    },
    location: {
      latitude: 37.78, longitude: -122.42, altitude_m: 10,
      bearing_deg: 180, speed_ms: 5, horizontal_accuracy_m: 5,
      has_fix: true, satellite_count: 7, gps_timestamp_ms: Date.now(),
    },
    openpilot: { engaged: false, state: "disabled", experimental_mode: false },
    driver: { face_detected: true, is_distracted: false, awareness_status: 1 },
  };

  const createRes2 = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await createRes2.text();

  const patchRes = await fetch(`${base}/events/response`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: eventId, dongle_id: "test-dongle-2", answer: "yes", latency_s: 2.1 }),
  });
  assertEquals(patchRes.status, 200);
  await patchRes.text();

  const getRes = await fetch(`${base}/events/${eventId}`);
  const updated = await getRes.json();
  assertEquals(updated.response.answer, "yes");
  assertEquals(updated.response.latency_s, 2.1);
  assertEquals(typeof updated.responded_at, "string");

  await server.shutdown();
}});
