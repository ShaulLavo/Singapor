import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorSecondaryWorkScheduler } from "../src/editor/secondaryWorkScheduler";

describe("EditorSecondaryWorkScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs only the latest work scheduled for a key", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new EditorSecondaryWorkScheduler();

    scheduler.schedule({ key: "syntax", delayMs: 50, run: () => calls.push("first") });
    vi.advanceTimersByTime(25);
    scheduler.schedule({ key: "syntax", delayMs: 50, run: () => calls.push("second") });

    vi.advanceTimersByTime(49);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["second"]);
  });

  it("skips work when the version guard is stale", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new EditorSecondaryWorkScheduler();

    scheduler.schedule({
      key: "features",
      delayMs: 25,
      version: 1,
      isCurrent: (version) => version === 2,
      run: () => calls.push("stale"),
    });

    vi.advanceTimersByTime(25);
    expect(calls).toEqual([]);
  });

  it("clears pending timers on dispose", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new EditorSecondaryWorkScheduler();

    scheduler.schedule({ key: "features", delayMs: 25, run: () => calls.push("run") });
    scheduler.dispose();
    vi.advanceTimersByTime(25);

    expect(calls).toEqual([]);
  });

  it("uses a zero-delay timer fallback instead of running synchronously", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new EditorSecondaryWorkScheduler();

    scheduler.schedule({ key: "features", run: () => calls.push("run") });
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(0);
    expect(calls).toEqual(["run"]);
  });
});
