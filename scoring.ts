import type { StoredHazard, ConfidenceTier } from "./types.ts";

/**
 * Compute a confidence score (0–100) and tier for a hazard.
 *
 * Factors:
 *   1. Report quality (35%) — weighted sum of event responses
 *      "yes" events count full, "timeout" count partial, "no" count minimal
 *   2. Confirm ratio (35%) — pass-through device confirmations vs clears
 *   3. Recency (30%) — recent activity scores higher than stale hazards
 *
 * The report quality factor replaces the old volume-only score.
 * All reports still count — a "no" response doesn't zero out the event,
 * it just contributes less confidence than a "yes".
 */

const WEIGHTS = {
  reportQuality: 0.35,
  confirmRatio: 0.35,
  recency: 0.30,
};

// How much each event response type contributes to the quality score.
// A "yes" is a strong signal. A timeout means the driver didn't reject it.
// A "no" still counts (the bump was real enough to trigger detection)
// but contributes much less confidence.
const RESPONSE_WEIGHTS = {
  yes: 1.0,
  timeout: 0.5,
  no: 0.2,
  // Events with no response yet (awaiting popup) treated like timeout
  pending: 0.5,
};

const RECENCY_HALF_LIFE_HOURS = 48;

/**
 * Report quality component (0–100).
 *
 * Each linked event contributes a weighted point based on the driver's response.
 * The raw weighted sum is then mapped through a log curve (diminishing returns)
 * so that a few strong "yes" reports quickly reach high confidence but
 * many weak "no" reports plateau lower.
 *
 * Examples:
 *   1 yes                    → weighted 1.0  → score ~45
 *   2 yes                    → weighted 2.0  → score ~71
 *   3 yes                    → weighted 3.0  → score ~86
 *   1 no                     → weighted 0.2  → score ~13
 *   1 yes + 1 no             → weighted 1.2  → score ~50
 *   3 yes + 2 timeout        → weighted 4.0  → score ~93
 *   5 no                     → weighted 1.0  → score ~45
 */
function reportQualityScore(hazard: StoredHazard): number {
  const yesCount = hazard.response_yes ?? 0;
  const noCount = hazard.response_no ?? 0;
  const timeoutCount = hazard.response_timeout ?? 0;
  // Events that haven't received a response yet
  const pendingCount = Math.max(0,
    hazard.report_count - yesCount - noCount - timeoutCount);

  const weighted =
    yesCount * RESPONSE_WEIGHTS.yes +
    timeoutCount * RESPONSE_WEIGHTS.timeout +
    noCount * RESPONSE_WEIGHTS.no +
    pendingCount * RESPONSE_WEIGHTS.pending;

  if (weighted <= 0) return 0;
  // log2 curve: maps weighted sum to 0–100 with diminishing returns
  // weighted 1.0 → ~45, 2.0 → ~71, 3.0 → ~86, 5.0 → ~97
  return Math.min(100, 45 * Math.log2(weighted + 1));
}

/**
 * Confirm ratio component (0–100).
 * Based on confirmed / (confirmed + rejected) from pass-through devices.
 * If no one has confirmed or rejected yet, returns 50 (neutral).
 */
function confirmRatioScore(confirmCount: number, rejectCount: number): number {
  const total = confirmCount + rejectCount;
  if (total === 0) return 50; // no data = neutral
  const ratio = confirmCount / total;
  const sampleBonus = Math.min(10, total * 2);
  return Math.min(100, ratio * 90 + sampleBonus);
}

/**
 * Recency component (0–100).
 * Exponential decay from the last report time.
 * Just reported = 100, 48h ago = 50, 96h ago = 25.
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
  const quality = reportQualityScore(hazard);
  const confirm = confirmRatioScore(hazard.confirm_count, hazard.reject_count);
  const recency = recencyScore(hazard.last_reported_at);

  const raw =
    quality * WEIGHTS.reportQuality +
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
