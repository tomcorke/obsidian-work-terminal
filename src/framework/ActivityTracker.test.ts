// Pin timezone to UTC so local-midnight calculations in classifyActivity
// match the hardcoded UTC timestamps used in these tests.
process.env.TZ = "UTC";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityTracker,
  classifyActivity,
  thresholdToMs,
  ACTIVITY_BUCKETS,
  ACTIVITY_BUCKET_LABELS,
  type RecentThreshold,
  type ActivityBucket,
} from "./ActivityTracker";

describe("thresholdToMs", () => {
  it("converts 1h to 3600000ms", () => {
    expect(thresholdToMs("1h")).toBe(3_600_000);
  });

  it("converts 3h to 10800000ms", () => {
    expect(thresholdToMs("3h")).toBe(10_800_000);
  });

  it("converts 24h to 86400000ms", () => {
    expect(thresholdToMs("24h")).toBe(86_400_000);
  });
});

describe("classifyActivity", () => {
  // Use a fixed "now" for deterministic tests: 2026-04-16 14:00:00 UTC
  const now = new Date("2026-04-16T14:00:00Z").getTime();

  it('returns "older" for undefined timestamp', () => {
    expect(classifyActivity(undefined, now, "3h")).toBe("older");
  });

  it('returns "recent" for activity 1 hour ago with 3h threshold', () => {
    const oneHourAgo = now - 60 * 60 * 1000;
    expect(classifyActivity(oneHourAgo, now, "3h")).toBe("recent");
  });

  it('returns "recent" for activity 2 hours ago with 3h threshold', () => {
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    expect(classifyActivity(twoHoursAgo, now, "3h")).toBe("recent");
  });

  it('returns "recent" for activity earlier today even if beyond threshold hours', () => {
    // "now" is 14:00 UTC, so "today" extends 14 hours back (to midnight)
    // With 3h threshold, today boundary (14h) > threshold (3h), so today wins
    const tenHoursAgo = now - 10 * 60 * 60 * 1000; // 04:00 today
    expect(classifyActivity(tenHoursAgo, now, "3h")).toBe("recent");
  });

  it('returns "last-7-days" for activity 2 days ago', () => {
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(twoDaysAgo, now, "3h")).toBe("last-7-days");
  });

  it('returns "last-30-days" for activity 10 days ago', () => {
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(tenDaysAgo, now, "3h")).toBe("last-30-days");
  });

  it('returns "older" for activity 60 days ago', () => {
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(sixtyDaysAgo, now, "3h")).toBe("older");
  });

  it("respects 1h threshold for recent classification", () => {
    // 2 hours ago should not be "recent" with 1h threshold
    // unless it's still today - at 14:00 UTC, today extends 14h back
    // So 2 hours ago is still "today" and thus "recent"
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    expect(classifyActivity(twoHoursAgo, now, "1h")).toBe("recent");
  });

  it("uses 1h threshold when today boundary is shorter than 1h", () => {
    // At 00:30 UTC, "today" is only 30 minutes. The 1h threshold should be used.
    const earlyMorning = new Date("2026-04-16T00:30:00Z").getTime();
    const fortyMinutesAgo = earlyMorning - 40 * 60 * 1000; // yesterday 23:50
    expect(classifyActivity(fortyMinutesAgo, earlyMorning, "1h")).toBe("recent");
  });

  it("24h threshold makes nearly full-day activity recent", () => {
    const twentyThreeHoursAgo = now - 23 * 60 * 60 * 1000;
    expect(classifyActivity(twentyThreeHoursAgo, now, "24h")).toBe("recent");
  });

  it('returns "last-7-days" for activity 2 days ago regardless of threshold', () => {
    // 2 days ago is always beyond any "today" or threshold boundary
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(twoDaysAgo, now, "3h")).toBe("last-7-days");
    expect(classifyActivity(twoDaysAgo, now, "24h")).toBe("last-7-days");
  });

  it("handles boundary at exactly 7 days", () => {
    const exactlySevenDays = now - 7 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(exactlySevenDays, now, "3h")).toBe("last-7-days");
  });

  it("handles boundary just past 7 days", () => {
    const justPastSevenDays = now - 7 * 24 * 60 * 60 * 1000 - 1;
    expect(classifyActivity(justPastSevenDays, now, "3h")).toBe("last-30-days");
  });

  it("handles boundary at exactly 30 days", () => {
    const exactlyThirtyDays = now - 30 * 24 * 60 * 60 * 1000;
    expect(classifyActivity(exactlyThirtyDays, now, "3h")).toBe("last-30-days");
  });

  it("handles boundary just past 30 days", () => {
    const justPastThirtyDays = now - 30 * 24 * 60 * 60 * 1000 - 1;
    expect(classifyActivity(justPastThirtyDays, now, "3h")).toBe("older");
  });
});

describe("ACTIVITY_BUCKETS", () => {
  it("has four buckets in display order", () => {
    expect(ACTIVITY_BUCKETS).toEqual(["recent", "last-7-days", "last-30-days", "older"]);
  });
});

describe("ACTIVITY_BUCKET_LABELS", () => {
  it("has labels for all buckets", () => {
    for (const bucket of ACTIVITY_BUCKETS) {
      expect(ACTIVITY_BUCKET_LABELS[bucket]).toBeTruthy();
    }
  });

  it("has correct labels", () => {
    expect(ACTIVITY_BUCKET_LABELS["recent"]).toBe("Recent");
    expect(ACTIVITY_BUCKET_LABELS["last-7-days"]).toBe("Last 7 Days");
    expect(ACTIVITY_BUCKET_LABELS["last-30-days"]).toBe("Last 30 Days");
    expect(ACTIVITY_BUCKET_LABELS["older"]).toBe("Older");
  });
});

describe("ActivityTracker", () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new ActivityTracker();
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  describe("recordActivity", () => {
    it("stores the current timestamp for an item", () => {
      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      expect(tracker.getTimestamp("item-1")).toBe(Date.now());
    });

    it("updates the timestamp on subsequent calls", () => {
      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      const first = tracker.getTimestamp("item-1");

      vi.setSystemTime(new Date("2026-04-16T10:05:00Z"));
      tracker.recordActivity("item-1");
      const second = tracker.getTimestamp("item-1");

      expect(second).toBeGreaterThan(first!);
    });
  });

  describe("seedFromFrontmatter", () => {
    it("sets the timestamp from an ISO string", () => {
      tracker.seedFromFrontmatter("item-1", "2026-04-16T08:00:00Z");
      expect(tracker.getTimestamp("item-1")).toBe(new Date("2026-04-16T08:00:00Z").getTime());
    });

    it("does not overwrite an existing in-memory timestamp", () => {
      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      const inMemory = tracker.getTimestamp("item-1");

      tracker.seedFromFrontmatter("item-1", "2026-04-16T08:00:00Z");
      expect(tracker.getTimestamp("item-1")).toBe(inMemory);
    });

    it("ignores undefined values", () => {
      tracker.seedFromFrontmatter("item-1", undefined);
      expect(tracker.getTimestamp("item-1")).toBeUndefined();
    });

    it("ignores empty strings", () => {
      tracker.seedFromFrontmatter("item-1", "");
      expect(tracker.getTimestamp("item-1")).toBeUndefined();
    });

    it("ignores invalid date strings", () => {
      tracker.seedFromFrontmatter("item-1", "not-a-date");
      expect(tracker.getTimestamp("item-1")).toBeUndefined();
    });
  });

  describe("getBucket", () => {
    it("returns the correct bucket for a tracked item", () => {
      const now = new Date("2026-04-16T14:00:00Z").getTime();
      vi.setSystemTime(now);
      tracker.recordActivity("item-1");

      expect(tracker.getBucket("item-1", now, "3h")).toBe("recent");
    });

    it('returns "older" for untracked items', () => {
      const now = Date.now();
      expect(tracker.getBucket("unknown", now, "3h")).toBe("older");
    });
  });

  describe("rekey", () => {
    it("transfers the timestamp to the new key", () => {
      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("old-id");
      const ts = tracker.getTimestamp("old-id");

      const result = tracker.rekey("old-id", "new-id");

      expect(result).toBe(true);
      expect(tracker.getTimestamp("new-id")).toBe(ts);
      expect(tracker.getTimestamp("old-id")).toBeUndefined();
    });

    it("returns false when the old key does not exist", () => {
      expect(tracker.rekey("missing", "new")).toBe(false);
    });
  });

  describe("flush throttling", () => {
    it("flushes immediately on first activity", () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      tracker.setFlushCallback(flushFn);

      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");

      expect(flushFn).toHaveBeenCalledTimes(1);
      expect(flushFn).toHaveBeenCalledWith(
        "item-1",
        expect.stringContaining("2026-04-16T10:00:00Z"),
      );
    });

    it("throttles subsequent flushes to 60 seconds", () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      tracker.setFlushCallback(flushFn);

      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      expect(flushFn).toHaveBeenCalledTimes(1);

      // Activity 30 seconds later - should NOT flush immediately
      vi.setSystemTime(new Date("2026-04-16T10:00:30Z"));
      tracker.recordActivity("item-1");
      expect(flushFn).toHaveBeenCalledTimes(1);

      // Advance to when the throttle timer fires (30 seconds remaining)
      vi.advanceTimersByTime(30_000);
      expect(flushFn).toHaveBeenCalledTimes(2);
    });

    it("uses the latest timestamp when the throttled flush fires", () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      tracker.setFlushCallback(flushFn);

      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");

      // Multiple activities within the throttle window
      vi.setSystemTime(new Date("2026-04-16T10:00:20Z"));
      tracker.recordActivity("item-1");
      vi.setSystemTime(new Date("2026-04-16T10:00:40Z"));
      tracker.recordActivity("item-1");

      // Advance past throttle
      vi.advanceTimersByTime(60_000);

      // The second flush should use the latest timestamp (10:00:40)
      const lastCall = flushFn.mock.calls[flushFn.mock.calls.length - 1];
      expect(lastCall[1]).toContain("2026-04-16T10:00:40Z");
    });

    it("flushes immediately after the throttle window expires", () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      tracker.setFlushCallback(flushFn);

      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      expect(flushFn).toHaveBeenCalledTimes(1);

      // Wait 61 seconds, then new activity
      vi.setSystemTime(new Date("2026-04-16T10:01:01Z"));
      vi.advanceTimersByTime(61_000);
      tracker.recordActivity("item-1");
      expect(flushFn).toHaveBeenCalledTimes(2);
    });

    it("does not flush if no callback is set", () => {
      // No callback set
      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");
      // Should not throw
    });
  });

  describe("dispose", () => {
    it("clears pending flush timers", () => {
      const flushFn = vi.fn().mockResolvedValue(undefined);
      tracker.setFlushCallback(flushFn);

      vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
      tracker.recordActivity("item-1");

      // Activity within throttle window creates a pending timer
      vi.setSystemTime(new Date("2026-04-16T10:00:30Z"));
      tracker.recordActivity("item-1");

      tracker.dispose();

      // Advancing time should not trigger the flush
      vi.advanceTimersByTime(60_000);
      expect(flushFn).toHaveBeenCalledTimes(1); // Only the initial immediate flush
    });
  });
});
