// -----------------------------------------------------------------------
// MenuNavigation — gamepad/keyboard cursor for HTML button menus.
//
// Title screen and game-over screen each register a list of focusable
// buttons; this module tracks which one is "selected" (visual cursor),
// reads d-pad / left-stick / arrow-keys to step the selection, and
// fires `.click()` on the focused element when A (gamepad btn 0/1)
// or keyboard Space/Enter is pressed.
//
// Scopes are stacked so opening a modal (leaderboard, achievements)
// pushes a new scope containing just the close button; popping
// restores focus on the underlying menu.
//
// Visual: the focused element gets the `menu-focused` class. CSS in
// index.html paints the bronze glow + scale.
//
// Why this design: the existing `Input` class already polls the
// gamepad every frame in the render loop. We just call `update(input)`
// once per frame from `Game.loop()` and react to `justPressed` edges.
// No new event listeners, no timers, no separate polling — fits the
// game's existing input model exactly.
// -----------------------------------------------------------------------

import type { Input } from "./input";

type Direction = "up" | "down" | "left" | "right";

export const MENU_FOCUS_CLASS = "menu-focused";

interface MenuScope {
  items: HTMLElement[];
  index: number;
  // Optional callback for when this scope is popped (e.g. modal close).
  // Currently unused — reserved for future B-button cancel support.
  onCancel?: () => void;
}

export class MenuNavigation {
  private readonly stack: MenuScope[] = [];
  // Suppress activation for one frame after a scope is pushed, so the
  // same A press that opened a modal doesn't immediately activate the
  // close button inside it.
  private suppressActivateFrames = 0;

  /**
   * Replace the entire scope stack with a single new scope. Use this
   * on entering a screen (title / game-over). The first visible item
   * is auto-focused.
   */
  setScope(items: HTMLElement[]): void {
    this.clearAll();
    if (items.length === 0) return;
    this.stack.push({ items, index: 0 });
    this.focusFirstVisible();
  }

  /**
   * Push a nested scope (e.g. modal close button). Restores prior
   * focus when popped.
   */
  pushScope(items: HTMLElement[], onCancel?: () => void): void {
    if (items.length === 0) return;
    // Hide focus on the parent scope so only the topmost is visually focused.
    this.removeFocusClass(this.top());
    this.stack.push({ items, index: 0, onCancel });
    this.focusFirstVisible();
    // Skip the next frame's activation read — the same A press that
    // pushed this scope shouldn't immediately confirm inside it.
    this.suppressActivateFrames = 1;
  }

  /** Pop the topmost scope and restore visual focus on the parent. */
  popScope(): void {
    const popped = this.stack.pop();
    if (popped) {
      this.removeFocusClass(popped);
    }
    // Restore parent focus highlight.
    const parent = this.top();
    if (parent) this.applyFocusClass(parent);
  }

  /** Detach entirely (game starts, no menus active). */
  detach(): void {
    this.clearAll();
  }

  /** Whether any scope is currently active. */
  isActive(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Read d-pad / arrow-key / A inputs and update focus + activate
   * focused button. Call once per frame (after `input.update()` and
   * before `input.endFrame()`).
   *
   * Returns true if the menu consumed the A press this frame, so the
   * caller can skip any legacy "space → start game" shortcut and
   * avoid double-firing.
   */
  update(input: Input): boolean {
    const scope = this.top();
    if (!scope) return false;

    // Filter to currently-visible, non-disabled items each frame.
    // A snapshot taken at scope creation can go stale (e.g., the
    // VERSUS GHOST button toggles visibility based on saved ghost).
    const visible = scope.items.filter(isInteractable);
    if (visible.length === 0) return false;

    // Re-anchor scope.index against the current visible list. If the
    // currently focused item is no longer visible, snap to 0.
    const currentEl = scope.items[scope.index];
    let visIdx = visible.indexOf(currentEl);
    if (visIdx < 0) {
      visIdx = 0;
      scope.index = scope.items.indexOf(visible[0]);
    }

    // Use justPressedDir (keyboard arrows/WASD + gamepad d-pad +
    // left-stick threshold) so menu nav works without a mouse on every
    // platform. Plain `justPressed("up")` etc. would miss gamepad input
    // because the stick/d-pad are folded into gamepadMovement, not the
    // keyboard "up/down/left/right" channels.
    const dirPressed: Direction | null =
      input.justPressedDir("up")    ? "up"    :
      input.justPressedDir("down")  ? "down"  :
      input.justPressedDir("left")  ? "left"  :
      input.justPressedDir("right") ? "right" :
      null;

    if (dirPressed !== null) {
      const next = findNeighbor(dirPressed, visible[visIdx], visible);
      if (next !== null) {
        scope.index = scope.items.indexOf(next);
      }
    }
    // Ensure visual focus stays on the current element (covers the case
    // where DOM was re-rendered and class was wiped).
    this.applyFocusClass(scope);

    // Cancel/back (Esc + gamepad B): if the topmost scope was opened
    // with an onCancel handler (modals push themselves with one), fire
    // it. The handler is responsible for closing whatever it opened —
    // which itself calls popScope, restoring parent focus.
    if (input.justPressedCancel()) {
      const cancel = scope.onCancel;
      if (cancel) {
        cancel();
        return false;
      }
    }

    if (this.suppressActivateFrames > 0) {
      this.suppressActivateFrames -= 1;
      return false;
    }

    if (input.justPressed("space")) {
      const target = scope.items[scope.index];
      if (target && isInteractable(target)) {
        // Defer the click() so the current frame's input read finishes
        // before any side effects (e.g. modal open) mutate DOM. Without
        // this, opening a modal mid-update can cause the parent scope
        // to lose its focused item before we return.
        queueMicrotask(() => {
          target.click();
        });
        return true;
      }
    }

    return false;
  }

  private top(): MenuScope | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  private focusFirstVisible(): void {
    const scope = this.top();
    if (!scope) return;
    const firstVisIdx = scope.items.findIndex(isInteractable);
    scope.index = firstVisIdx >= 0 ? firstVisIdx : 0;
    this.applyFocusClass(scope);
  }

  private applyFocusClass(scope: MenuScope): void {
    for (let i = 0; i < scope.items.length; i++) {
      const el = scope.items[i];
      if (i === scope.index) {
        el.classList.add(MENU_FOCUS_CLASS);
      } else {
        el.classList.remove(MENU_FOCUS_CLASS);
      }
    }
  }

  private removeFocusClass(scope: MenuScope | undefined): void {
    if (!scope) return;
    for (const el of scope.items) {
      el.classList.remove(MENU_FOCUS_CLASS);
    }
  }

  private clearAll(): void {
    while (this.stack.length > 0) {
      this.removeFocusClass(this.stack.pop());
    }
  }
}

function isInteractable(el: HTMLElement): boolean {
  if (!el || !el.isConnected) return false;
  // offsetParent is null when the element (or any ancestor) is
  // display:none. visibility:hidden / opacity:0 are intentionally
  // treated as visible — they're typically used for animation, not
  // for hiding a button from interaction.
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.classList.contains("hidden")) return false;
  return true;
}

// -----------------------------------------------------------------------
// Spatial directional navigation — rect-based d-pad algorithm.
//
// Candidate selection (commit 4b8c65e + 85c8018 + this patch):
//   1. Aligned candidates (their rect brackets our center on the cross-axis,
//      i.e. same row for horizontal moves, same column for vertical moves)
//      win categorically over non-aligned. The original tier1 stratification
//      (±ROW_TOLERANCE around minPrimaryDist) ensures an aligned candidate
//      that is in a farther row doesn't win over a closer non-aligned row.
//   2. When NO aligned candidates exist, snap to the nearest perpendicular
//      row/column first (smallest perpOffset), then break ties by primaryDist.
//      This is the "snap to nearest row" intuition: pressing LEFT from a
//      full-width centered PLAY button should land on row-2 ACHIEVEMENTS,
//      not row-3 VERSUS GHOST which shares the same horizontal midpoint.
// -----------------------------------------------------------------------

/** Buttons that land within the same visual row should compete together. */
const ROW_TOLERANCE = 30;

/**
 * Minimum off-axis displacement (as a fraction of the current element's
 * size on the pressed axis) required for a candidate to count as being
 * in that direction. Prevents a button that is "directly below" the
 * current one from being picked as a LEFT/RIGHT neighbor just because
 * its center is 1–2px off-axis from sub-pixel flex centering.
 */
const HALF_PLANE_DEADBAND = 0.4;


/**
 * Return the best navigable neighbor in `direction` from `currentEl`
 * among the `visible` list, using spatial rect scoring.
 *
 * - Candidates in the wrong half-plane are excluded.
 * - If none exist (edge of the layout), wraps to the farthest item in
 *   the opposite direction, preferring the closest perpendicular offset.
 */
function findNeighbor(
  direction: Direction,
  currentEl: HTMLElement,
  visible: HTMLElement[]
): HTMLElement | null {
  const candidates = visible.filter((el) => el !== currentEl);
  if (candidates.length === 0) return null;

  const cur  = currentEl.getBoundingClientRect();
  const curCx = (cur.left + cur.right) / 2;
  const curCy = (cur.top  + cur.bottom) / 2;

  const horizontal = direction === "right" || direction === "left";
  const forward    = direction === "right" || direction === "down";

  const curPrimary = horizontal ? curCx : curCy;
  const curPerp    = horizontal ? curCy : curCx;

  const curSize = horizontal ? cur.width : cur.height;
  const minDelta = curSize * HALF_PLANE_DEADBAND;

  interface Scored {
    el: HTMLElement;
    index: number;
    aligned: boolean;
    primaryDist: number;
    perpOffset: number;
  }

  function scoreCandidate(el: HTMLElement, index: number): Scored | null {
    const r  = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top  + r.bottom) / 2;

    const candidatePrimary = horizontal ? cx : cy;
    const candidatePerp    = horizontal ? cy : cx;

    // Exclude candidates not meaningfully ahead of us on the primary axis.
    // The deadband (HALF_PLANE_DEADBAND × current element size) rejects any
    // button whose center is within the deadband of ours on the pressed axis —
    // preventing a button that is "directly below" from winning a sideways
    // press when sub-pixel flex centering leaves its cx 1–2px off from ours.
    const delta = candidatePrimary - curPrimary;
    if (forward) {
      if (delta < minDelta) return null;
    } else {
      if (delta > -minDelta) return null;
    }

    const primaryDist = Math.abs(candidatePrimary - curPrimary);
    const perpOffset  = Math.abs(candidatePerp    - curPerp);

    const aligned = horizontal
      ? r.top  <= curCy && r.bottom >= curCy
      : r.left <= curCx && r.right  >= curCx;

    return { el, index, aligned, primaryDist, perpOffset };
  }

  const scored = candidates
    .map((el, index) => scoreCandidate(el, index))
    .filter((s): s is Scored => s !== null);

  if (scored.length > 0) {
    if (scored.some((s) => s.aligned)) {
      // At least one aligned candidate — use the original tier1 stratification
      // (commit 85c8018). Limiting to minPrimary ± ROW_TOLERANCE naturally
      // excludes aligned candidates that are in a farther row/column (e.g.
      // DOWN-from-PLAY: VERSUS GHOST is "aligned" because it sits directly
      // below, but it's in row 3; ACHIEVEMENTS/LEADERBOARD in row 2 are
      // closer and land in tier1 instead). Within tier1, aligned wins over
      // non-aligned via the perpOffset≈0 advantage they inherently have.
      const minPrimary = scored.reduce(
        (min, c) => Math.min(min, c.primaryDist),
        Number.POSITIVE_INFINITY,
      );
      const tier1 = scored.filter((c) => c.primaryDist <= minPrimary + ROW_TOLERANCE);
      tier1.sort((a, b) => {
        if (a.perpOffset !== b.perpOffset) return a.perpOffset - b.perpOffset;
        if (a.aligned !== b.aligned) return a.aligned ? -1 : 1;
        return a.index - b.index;
      });
      return tier1[0].el;
    }

    // No row/col-aligned candidates — snap to the nearest row/column first
    // (smallest perpOffset), then closest primary-axis distance as a
    // tie-breaker. This fixes LEFT-from-PLAY landing on VERSUS GHOST (row 3)
    // instead of ACHIEVEMENTS (row 2) when VERSUS GHOST's center happens to
    // share PLAY's horizontal midpoint, giving it a near-zero primaryDist.
    const nonAligned = scored.slice().sort((a, b) => {
      if (a.perpOffset !== b.perpOffset) return a.perpOffset - b.perpOffset;
      return a.primaryDist - b.primaryDist;
    });
    return nonAligned[0].el;
  }

  // Wraparound — no candidates in the primary half-plane. Return the item
  // at the extreme opposite end of the pressed axis, breaking ties by
  // perpendicular closeness to our center.
  //
  // "right" wraps to leftmost  (minimum cx)   → extremeVal =  cx
  // "left"  wraps to rightmost (maximum cx)   → extremeVal = -cx
  // "down"  wraps to topmost   (minimum cy)   → extremeVal =  cy
  // "up"    wraps to bottommost (maximum cy)  → extremeVal = -cy
  interface Wrapped { el: HTMLElement; extremeVal: number; perpOffset: number }

  const wrapped = candidates
    .map((el): Wrapped => {
      const r  = el.getBoundingClientRect();
      const cx = (r.left + r.right) / 2;
      const cy = (r.top  + r.bottom) / 2;
      const candidatePrimary = horizontal ? cx : cy;
      const candidatePerp    = horizontal ? cy : cx;
      return {
        el,
        extremeVal: forward ? candidatePrimary : -candidatePrimary,
        perpOffset: Math.abs(candidatePerp - curPerp),
      };
    })
    .sort((a, b) =>
      a.extremeVal !== b.extremeVal
        ? a.extremeVal - b.extremeVal
        : a.perpOffset - b.perpOffset
    );

  return wrapped[0]?.el ?? null;
}
