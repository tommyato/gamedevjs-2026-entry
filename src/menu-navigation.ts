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

    const stepNext = input.justPressed("down") || input.justPressed("right");
    const stepPrev = input.justPressed("up") || input.justPressed("left");

    if (stepNext && !stepPrev) {
      visIdx = (visIdx + 1) % visible.length;
      scope.index = scope.items.indexOf(visible[visIdx]);
      this.applyFocusClass(scope);
    } else if (stepPrev && !stepNext) {
      visIdx = (visIdx - 1 + visible.length) % visible.length;
      scope.index = scope.items.indexOf(visible[visIdx]);
      this.applyFocusClass(scope);
    } else {
      // Even if no nav this frame, ensure visual focus stays on the
      // current element (covers the case where DOM was re-rendered
      // and class was wiped).
      this.applyFocusClass(scope);
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
