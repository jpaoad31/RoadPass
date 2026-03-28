/** Incoming hazard event from a device */
export interface HazardEventPayload {
  event_id: string;
  dongle_id: string;
  detected_at_ms: number;
  trigger_source: "bump_detector" | "manual";

  vehicle: {
    speed_ms: number;
    accel_ms2: number;
    yaw_rate_rads: number;
    steering_angle_deg: number;
    brake_pressed: boolean;
    gear: string;
    wheel_speeds: { fl: number; fr: number; rl: number; rr: number };
  };

  location: {
    latitude: number;
    longitude: number;
    altitude_m: number;
    bearing_deg: number;
    speed_ms: number;
    horizontal_accuracy_m: number;
    has_fix: boolean;
    satellite_count: number;
    gps_timestamp_ms: number;
  };

  openpilot: {
    engaged: boolean;
    state: string;
    experimental_mode: boolean;
  };

  driver: {
    face_detected: boolean;
    is_distracted: boolean;
    awareness_status: number;
  };

  response?: {
    answer: "yes" | "no" | "timeout";
    latency_s: number;
  };
}

/** Stored hazard event (payload + server metadata) */
export interface StoredHazardEvent extends HazardEventPayload {
  created_at: string; // ISO 8601
  responded_at?: string; // ISO 8601
}

/** Response update from a device */
export interface ResponseUpdate {
  event_id: string;
  response: "yes" | "no" | "timeout";
  response_latency_s: number;
}

/** What the "hazards ahead" endpoint returns per hazard */
export interface HazardAhead {
  event_id: string;
  latitude: number;
  longitude: number;
  distance_m: number;
  bearing_deg: number;
  trigger_source: string;
  detected_at_ms: number;
  accel_ms2: number;
  response_summary: {
    yes_count: number;
    no_count: number;
    total_reports: number;
  };
}

/** Road info from Nominatim */
export interface RoadInfo {
  osm_way_id: string | null;
  road_name: string | null;
  road_ref: string | null;
  display_name: string | null;
}

/** Full response for the "hazards ahead" query */
export interface HazardsAheadResponse {
  road: RoadInfo;
  hazards: HazardAhead[];
}
