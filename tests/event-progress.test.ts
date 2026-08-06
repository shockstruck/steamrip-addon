import { describe, expect, it } from "bun:test";
import { setEventProgress, type ProgressEvent } from "../lib/event-progress";

describe("setEventProgress", () => {
  it("uses the event progress method when available", () => {
    const updates: number[] = [];
    const event: ProgressEvent = {
      progress: 0,
      setProgress: (progress: number) => updates.push(progress),
    };

    setEventProgress(event, 125);

    expect(updates).toEqual([100]);
    expect(event.progress).toBe(0);
  });

  it("supports SDK events that expose the streamed progress field", () => {
    const event: ProgressEvent = { progress: 0 };

    setEventProgress(event, 42);

    expect(event.progress).toBe(42);
  });
});
