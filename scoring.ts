import type { StoredHazard, ConfidenceTier } from "./types.ts";

/**
 * Compute a confidence score (0–100) and tier for a hazard.
 *
 * Factors:
 *   1. Report volume — more independent reports = more likely real
 *   2. Confirm ratio — what fraction of pass-through devices confirmed it
 *   3. Recency — recent activity scores higher than stale hazards
 *
 * The score is a weighted blend of these three signals.
 */

const WEIGHTS = {
  volume: 0.30,
  confirmRatio: 0.45,
  recency: 0.25,
};

// How many hours before a hazard starts losing recency points
const RECENCY_HALF_LIFE_HOURS = 48;

/**
 * Volume component (0–100).
 * 1 report = 15, 2 = 35, 3 = 55, 5+ = 80+, 10+ = ~100
 * Diminishing returns via log curve.
 */
function volumeScore(reportCount: number): number {
  if (reportCount <= 0) return 0;
  // log2 curve: score = 30 * log2(count + 1), capped at 100
  return Math.min(100, 30 * Math.log2(reportCount + 1));
}

/**
 * Confirm ratio component (0–100).
 * Based on confirmed / (confirmed + rejected).
 * If no one has confirmed or rejected yet, returns 50 (neutral).
 */
function confirmRatioScore(confirmCount: number, rejectCount: number): number {
  const total = confirmCount + rejectCount;
  if (total === 0) return 50; // no data = neutral
  const ratio = confirmCount / total;
  // Scale 0–1 ratio to 0–100, with a small bonus for high sample counts
  const sampleBonus = Math.min(10, total * 2); // up to 10 bonus points
  return Math.min(100, ratio * 90 + sampleBonus);
}

/**
 * Recency component (0–100).
 * Exponential decay from the last report time.
 * Just reported = 100, 48h ago = 50, 96h ago = 25, etc.
 */
function recencyScore(lastReportedAt: string): number {
  const ageMs = Date.now() - new Date(lastReportedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= 0) return 100;
  return 100 * Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
}

/**
 * Compute the overall confidence score and tier for a hazard.
 */
export function computeConfidence(hazard: StoredHazard): {
  score: number;
  tier: ConfidenceTier;
} {
  const vol = volumeScore(hazard.report_count);
  const confirm = confirmRatioScore(hazard.confirm_count, hazard.reject_count);
  const recency = recencyScore(hazard.last_reported_at);

  const raw =
    vol * WEIGHTS.volume +
    confirm * WEIGHTS.confirmRatio +
    recency * WEIGHTS.recency;

  const score = Math.round(Math.min(100, Math.max(0, raw)));

  let tier: ConfidenceTier;
  if (score >= 65) {
    tier = "high";
  } else if (score >= 35) {
    tier = "medium";
  } else {
    tier = "low";
  }

  return { score, tier };
}
