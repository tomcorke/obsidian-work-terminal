import { describe, it, expect } from "vitest";
import {
  assignBucket,
  getRecentCutoff,
  groupByActivity,
  ACTIVITY_BUCKET_ORDER,
} from "./ActivityGrouper";
import type { WorkItem } from "./interfaces";

function makeItem(id: string, state = "active"): WorkItem {
  return { id, path: `tasks/${id}.md`, title: `Task ${id}`, state, metadata: {} };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Use a "now" that is well into the local day (14:30 local) so start-of-day
// is unambiguously earlier than a 3h threshold lookback.
function makeLocalAfternoon(): number {
  const d = new Date();
  d.setHours(14, 30, 0, 0);
  return d.getTime();
}

function getLocalStartOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const NOW = makeLocalAfternoon();

describe("getRecentCutoff", () => {
  it("returns start-of-today when threshold is shorter than time-since-midnight", () => {
    // At 14:30 local, start-of-today is 14.5 hours ago.
    // With 3h threshold: cutoff is 3h ago (11:30 local).
    // Start-of-today (00:00 local) is earlier than 11:30 local.
    // min(11:30, 00:00) = 00:00 = start of today
    const cutoff3h = getRecentCutoff(NOW, "3h");
    const startOfToday = getLocalStartOfDay(NOW);
    expect(cutoff3h).toBe(startOfToday);
  });

  it("uses threshold when it extends before today", () => {
    // With 24h threshold: cutoff is 24h ago.
    // Start-of-today is only ~14.5h ago.
    // min(24h ago, ~14.5h ago) = 24h ago
    const cutoff24h = getRecentCutoff(NOW, "24h");
    expect(cutoff24h).toBe(NOW - 24 * HOUR);
  });

  it("uses threshold early in the day when it is earlier than start-of-day", () => {
    // At 00:15 local, start-of-today is 15 min ago.
    // With 1h threshold: cutoff is 1h ago = yesterday 23:15 local.
    // min(yesterday 23:15, today 00:00) = yesterday 23:15
    const d = new Date();
    d.setHours(0, 15, 0, 0);
    const earlyMorning = d.getTime();
    const cutoff = getRecentCutoff(earlyMorning, "1h");
    expect(cutoff).toBe(earlyMorning - HOUR);
  });
});

describe("assignBucket", () => {
  it("assigns undefined timestamps to older", () => {
    expect(assignBucket(undefined, NOW, "3h")).toBe("older");
  });

  it("assigns recent items to recent bucket", () => {
    // 1 hour ago
    expect(assignBucket(NOW - HOUR, NOW, "3h")).toBe("recent");
  });

  it("assigns items from earlier today to recent (today floor)", () => {
    // 10 hours ago (still today since we're at 14:30 local)
    expect(assignBucket(NOW - 10 * HOUR, NOW, "3h")).toBe("recent");
  });

  it("assigns 2-day-old items to last-7-days", () => {
    expect(assignBucket(NOW - 2 * DAY, NOW, "3h")).toBe("last-7-days");
  });

  it("assigns 10-day-old items to last-30-days", () => {
    expect(assignBucket(NOW - 10 * DAY, NOW, "3h")).toBe("last-30-days");
  });

  it("assigns 60-day-old items to older", () => {
    expect(assignBucket(NOW - 60 * DAY, NOW, "3h")).toBe("older");
  });

  it("respects 1h threshold boundary", () => {
    // Item from 2h ago, at 14:30 with 1h threshold
    // Recent cutoff = min(13:30, 00:00) = 00:00 (start of today)
    // 2h ago = 12:30, which is after 00:00 => still recent
    expect(assignBucket(NOW - 2 * HOUR, NOW, "1h")).toBe("recent");
  });
});

describe("groupByActivity", () => {
  it("groups items into correct buckets", () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c"), makeItem("d"), makeItem("e")];

    const timestamps = new Map<string, number>([
      ["a", NOW - HOUR], // recent
      ["b", NOW - 3 * DAY], // last-7-days
      ["c", NOW - 15 * DAY], // last-30-days
      ["d", NOW - 60 * DAY], // older
      // "e" has no timestamp  // older
    ]);

    const groups = groupByActivity(items, timestamps, "3h", NOW);

    expect(groups.recent.map((i) => i.id)).toEqual(["a"]);
    expect(groups["last-7-days"].map((i) => i.id)).toEqual(["b"]);
    expect(groups["last-30-days"].map((i) => i.id)).toEqual(["c"]);
    expect(groups.older.map((i) => i.id)).toEqual(["d", "e"]);
  });

  it("sorts within buckets by recency (most recent first)", () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const timestamps = new Map<string, number>([
      ["a", NOW - 5 * DAY],
      ["b", NOW - 2 * DAY],
      ["c", NOW - 6 * DAY],
    ]);

    const groups = groupByActivity(items, timestamps, "3h", NOW);
    // All in last-7-days, sorted by recency
    expect(groups["last-7-days"].map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("places items without timestamps at end of older", () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const timestamps = new Map<string, number>([
      ["b", NOW - 60 * DAY], // in "older" with timestamp
    ]);

    const groups = groupByActivity(items, timestamps, "3h", NOW);
    // "b" has a timestamp so comes first, "a" and "c" have none
    expect(groups.older[0].id).toBe("b");
  });

  it("handles empty items list", () => {
    const groups = groupByActivity([], new Map(), "3h", NOW);
    for (const bucket of ACTIVITY_BUCKET_ORDER) {
      expect(groups[bucket]).toEqual([]);
    }
  });

  it("includes all items regardless of state", () => {
    const items = [makeItem("a", "active"), makeItem("b", "done"), makeItem("c", "priority")];
    const timestamps = new Map<string, number>([
      ["a", NOW - HOUR],
      ["b", NOW - HOUR],
      ["c", NOW - HOUR],
    ]);

    const groups = groupByActivity(items, timestamps, "3h", NOW);
    expect(groups.recent).toHaveLength(3);
  });
});
