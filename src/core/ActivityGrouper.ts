/**
 * ActivityGrouper - groups work items into recency buckets based on
 * last-active timestamps.
 *
 * Buckets:
 * 1. Recent - today or last N hours (configurable), whichever is longer
 * 2. Last 7 days
 * 3. Last 30 days
 * 4. Older
 *
 * Items without timestamps are placed in "Older".
 */
import type { WorkItem } from "./interfaces";

/** Configurable threshold for the "Recent" bucket. */
export type RecentThreshold = "1h" | "3h" | "24h";

/** Activity bucket identifiers (used as section keys). */
export type ActivityBucket = "recent" | "last-7-days" | "last-30-days" | "older";

export const ACTIVITY_BUCKET_LABELS: Record<ActivityBucket, string> = {
  recent: "Recent",
  "last-7-days": "Last 7 Days",
  "last-30-days": "Last 30 Days",
  older: "Older",
};

export const ACTIVITY_BUCKET_ORDER: ActivityBucket[] = [
  "recent",
  "last-7-days",
  "last-30-days",
  "older",
];

export const RECENT_THRESHOLD_LABELS: Record<RecentThreshold, string> = {
  "1h": "Last hour",
  "3h": "Last 3 hours (default)",
  "24h": "Last 24 hours",
};

const RECENT_THRESHOLD_MS: Record<RecentThreshold, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Determine the start-of-day timestamp for a given time (local timezone),
 * used to ensure "today" is always included in the Recent bucket.
 */
function getStartOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Compute the cutoff timestamp for the "Recent" bucket.
 * Returns the earlier of (now - threshold) and start-of-today, ensuring
 * "today or last N hours, whichever is longer".
 */
export function getRecentCutoff(now: number, threshold: RecentThreshold): number {
  const thresholdCutoff = now - RECENT_THRESHOLD_MS[threshold];
  const startOfToday = getStartOfDay(now);
  return Math.min(thresholdCutoff, startOfToday);
}

/**
 * Assign an item to a recency bucket based on its last-active timestamp.
 */
export function assignBucket(
  timestamp: number | undefined,
  now: number,
  threshold: RecentThreshold,
): ActivityBucket {
  if (timestamp === undefined) return "older";

  const recentCutoff = getRecentCutoff(now, threshold);
  if (timestamp >= recentCutoff) return "recent";

  const sevenDaysAgo = now - SEVEN_DAYS_MS;
  if (timestamp >= sevenDaysAgo) return "last-7-days";

  const thirtyDaysAgo = now - THIRTY_DAYS_MS;
  if (timestamp >= thirtyDaysAgo) return "last-30-days";

  return "older";
}

/**
 * Group items into activity buckets. Returns a record keyed by bucket ID
 * with items ordered by their activity timestamp (most recent first within
 * each bucket). Items without timestamps are placed at the end of "older".
 */
export function groupByActivity(
  items: WorkItem[],
  timestamps: Map<string, number>,
  threshold: RecentThreshold,
  now?: number,
): Record<ActivityBucket, WorkItem[]> {
  const currentTime = now ?? Date.now();
  const groups: Record<ActivityBucket, WorkItem[]> = {
    recent: [],
    "last-7-days": [],
    "last-30-days": [],
    older: [],
  };

  for (const item of items) {
    const ts = timestamps.get(item.id);
    const bucket = assignBucket(ts, currentTime, threshold);
    groups[bucket].push(item);
  }

  // Sort within each bucket: items with timestamps by recency, items without at end
  for (const bucket of ACTIVITY_BUCKET_ORDER) {
    groups[bucket].sort((a, b) => {
      const tsA = timestamps.get(a.id);
      const tsB = timestamps.get(b.id);
      if (tsA === undefined && tsB === undefined) return 0;
      if (tsA === undefined) return 1;
      if (tsB === undefined) return -1;
      return tsB - tsA; // Most recent first
    });
  }

  return groups;
}
