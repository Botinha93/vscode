import { describe, expect, test } from "bun:test";
import {
  STICK_TO_BOTTOM_PX,
  captureBoxState,
  isAtBottom,
  pickAnchor,
  restoredScrollTop,
  restoredTranscriptTop,
} from "../src/webview/view-state";

const box = (scrollTop: number, scrollHeight: number, clientHeight = 200) => ({ scrollTop, scrollHeight, clientHeight });

describe("isAtBottom", () => {
  test("counts anything within the stick threshold as the bottom", () => {
    expect(isAtBottom(box(800, 1000))).toBe(true);
    expect(isAtBottom(box(800 - STICK_TO_BOTTOM_PX, 1000))).toBe(true);
    expect(isAtBottom(box(800 - STICK_TO_BOTTOM_PX - 1, 1000))).toBe(false);
    // Content shorter than the box is always at its bottom.
    expect(isAtBottom(box(0, 100))).toBe(true);
  });
});

describe("restoredScrollTop (inner scroll boxes)", () => {
  test("a box the user scrolled up keeps its offset while content grows", () => {
    const before = captureBoxState(box(120, 1000));
    expect(restoredScrollTop(before, box(0, 1400), true)).toBe(120);
    expect(restoredScrollTop(before, box(0, 1400), false)).toBe(120);
  });

  test("a box at its bottom follows the tail", () => {
    const before = captureBoxState(box(790, 1000));
    expect(restoredScrollTop(before, box(0, 1400), false)).toBe(1200);
  });

  test("a new live box starts at its tail; a new static box is left alone", () => {
    expect(restoredScrollTop(undefined, box(0, 900), true)).toBe(700);
    expect(restoredScrollTop(undefined, box(0, 900), false)).toBeUndefined();
  });

  test("an offset past the new end is clamped", () => {
    expect(restoredScrollTop(captureBoxState(box(500, 2000)), box(0, 600), false)).toBe(400);
  });
});

describe("transcript anchoring", () => {
  const viewport = { scrollTop: 1000, clientHeight: 500 };

  test("anchors on the first element starting inside the viewport", () => {
    const anchor = pickAnchor([
      { key: "turn:a", top: 0, bottom: 900 },
      { key: "turn:b", top: 900, bottom: 1600 },
      { key: "run:r1", top: 1100, bottom: 1300 },
      { key: "step:s1", top: 1050, bottom: 1200 },
      { key: "turn:c", top: 1600, bottom: 2000 },
    ], viewport);
    expect(anchor?.key).toBe("step:s1");
  });

  test("falls back to the innermost element straddling the viewport top", () => {
    const anchor = pickAnchor([
      { key: "turn:a", top: 0, bottom: 3000 },
      { key: "run:r1", top: 800, bottom: 2000 },
    ], viewport);
    expect(anchor?.key).toBe("run:r1");
  });

  test("keeps the anchor where it was on screen when content above it grows", () => {
    const previous = { top: 1000, atBottom: false, anchor: { key: "step:s1", top: 1050, bottom: 1200 } };
    // A run card above the step grew by 300px: the step is now at 1350.
    expect(restoredTranscriptTop(previous, box(0, 5000, 500), 1350)).toBe(1300);
  });

  test("keeps the old offset when the anchor is gone, and follows the bottom when it was there", () => {
    const previous = { top: 1000, atBottom: false, anchor: { key: "step:s1", top: 1050, bottom: 1200 } };
    expect(restoredTranscriptTop(previous, box(0, 5000, 500), undefined)).toBe(1000);
    expect(restoredTranscriptTop({ top: 4500, atBottom: true }, box(0, 6000, 500), undefined)).toBe(5500);
  });

  test("a full re-render (scrollTop reset to 0 by innerHTML) restores the old position, not the top", () => {
    const previous = { top: 1000, atBottom: false, anchor: { key: "turn:b", top: 900, bottom: 1600 } };
    expect(restoredTranscriptTop(previous, box(0, 5000, 500), 900)).toBe(1000);
  });
});
