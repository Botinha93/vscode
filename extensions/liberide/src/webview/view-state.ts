/**
 * Scroll preservation for the chat webview. Live updates (agent runs, graph
 * patches, streamed text) re-render parts of the transcript with innerHTML;
 * these helpers carry the user's place across a re-render:
 *
 * - the transcript sticks to the bottom only while the user is at the bottom
 *   (within STICK_TO_BOTTOM_PX); otherwise an anchor element (a turn, run card
 *   or graph step) keeps its on-screen position as content above it grows;
 * - every inner scroll box (live run text, step output, reasoning, errors)
 *   is keyed (`data-scroll-key`) and gets its scrollTop back, following its
 *   tail only while the user was at its bottom.
 *
 * The logic is pure (plain numbers in, numbers out) so it is unit tested
 * without a DOM; chat-main.ts does the DOM reads and writes.
 */

/** Within this many pixels of the bottom counts as "at the bottom". */
export const STICK_TO_BOTTOM_PX = 40;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Where a scroll box was before a re-render. */
export interface BoxState {
  top: number;
  atBottom: boolean;
}

export function isAtBottom(box: ScrollMetrics, threshold = STICK_TO_BOTTOM_PX): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

export function captureBoxState(box: ScrollMetrics): BoxState {
  return { top: box.scrollTop, atBottom: isAtBottom(box) };
}

/**
 * The scrollTop to give a (possibly re-created) scroll box after a re-render,
 * or undefined to leave it alone. A box at its bottom before follows the tail;
 * one the user scrolled keeps its offset; a new box starts at its tail only
 * when it is a live (`follow`) box.
 */
export function restoredScrollTop(previous: BoxState | undefined, box: ScrollMetrics, follow: boolean): number | undefined {
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  if (!previous) return follow ? max : undefined;
  if (previous.atBottom) return max;
  return Math.min(previous.top, max);
}

/** An element that can anchor the transcript, in content coordinates (scrollTop-independent). */
export interface AnchorCandidate {
  key: string;
  /** Distance from the top of the scroll content. */
  top: number;
  bottom: number;
}

/**
 * The element whose position the transcript keeps: the first one starting
 * inside the viewport, else the innermost (latest-starting) one straddling
 * the viewport top.
 */
export function pickAnchor(candidates: Iterable<AnchorCandidate>, viewport: { scrollTop: number; clientHeight: number }): AnchorCandidate | undefined {
  const viewTop = viewport.scrollTop;
  const viewBottom = viewport.scrollTop + viewport.clientHeight;
  let inside: AnchorCandidate | undefined;
  let straddling: AnchorCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.bottom <= viewTop || candidate.top >= viewBottom) continue;
    if (candidate.top >= viewTop) {
      if (!inside || candidate.top < inside.top) inside = candidate;
    } else if (!straddling || candidate.top >= straddling.top) {
      straddling = candidate;
    }
  }
  return inside ?? straddling;
}

/** What the transcript looked like before a re-render. */
export interface TranscriptState extends BoxState {
  anchor?: AnchorCandidate;
}

/**
 * The transcript's scrollTop after a re-render: the bottom while following,
 * else shifted by however far the anchor moved, else the old offset.
 */
export function restoredTranscriptTop(previous: TranscriptState, box: ScrollMetrics, anchorTopAfter: number | undefined): number {
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  if (previous.atBottom) return max;
  const top = previous.anchor && anchorTopAfter !== undefined
    ? previous.top + (anchorTopAfter - previous.anchor.top)
    : previous.top;
  return Math.min(Math.max(0, top), max);
}
