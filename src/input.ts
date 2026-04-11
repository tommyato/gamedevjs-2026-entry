/**
 * Input system — keyboard, mouse, and touch support.
 * Handles both discrete (justPressed) and continuous (isDown) input.
 */

type InputKey = "left" | "right" | "up" | "down" | "space" | "click";

export class Input {
  private keys = new Map<string, boolean>();
  private prevKeys = new Map<string, boolean>();
  private mouseX = 0;
  private mouseY = 0;
  private touchActive = false;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchDeltaX = 0;
  private touchDeltaY = 0;

  init(canvas: HTMLElement) {
    // Keyboard
    window.addEventListener("keydown", (e) => {
      this.keys.set(e.key.toLowerCase(), true);
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.set(e.key.toLowerCase(), false);
    });

    // Mouse
    canvas.addEventListener("mousedown", (e) => {
      this.keys.set("click", true);
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener("mouseup", () => {
      this.keys.set("click", false);
    });
    canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    // Touch
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.touchActive = true;
      this.keys.set("click", true);
      const t = e.touches[0];
      this.touchStartX = t.clientX;
      this.touchStartY = t.clientY;
      this.touchDeltaX = 0;
      this.touchDeltaY = 0;
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (e.touches.length > 0) {
        const t = e.touches[0];
        this.touchDeltaX = t.clientX - this.touchStartX;
        this.touchDeltaY = t.clientY - this.touchStartY;
      }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      this.touchActive = false;
      this.keys.set("click", false);
      this.touchDeltaX = 0;
      this.touchDeltaY = 0;
    }, { passive: false });
  }

  update() {
    // Store previous frame state
    for (const [key, val] of this.keys) {
      this.prevKeys.set(key, val);
    }
  }

  endFrame() {
    // Copy current to prev after processing
    for (const [key, val] of this.keys) {
      this.prevKeys.set(key, val);
    }
  }

  isDown(key: InputKey): boolean {
    switch (key) {
      case "left": return this.keys.get("a") || this.keys.get("arrowleft") || false;
      case "right": return this.keys.get("d") || this.keys.get("arrowright") || false;
      case "up": return this.keys.get("w") || this.keys.get("arrowup") || false;
      case "down": return this.keys.get("s") || this.keys.get("arrowdown") || false;
      case "space": return this.keys.get(" ") || false;
      case "click": return this.keys.get("click") || false;
    }
  }

  justPressed(key: InputKey): boolean {
    const down = this.isDown(key);
    const wasPrev = this.wasDown(key);
    return down && !wasPrev;
  }

  private wasDown(key: InputKey): boolean {
    switch (key) {
      case "left": return this.prevKeys.get("a") || this.prevKeys.get("arrowleft") || false;
      case "right": return this.prevKeys.get("d") || this.prevKeys.get("arrowright") || false;
      case "up": return this.prevKeys.get("w") || this.prevKeys.get("arrowup") || false;
      case "down": return this.prevKeys.get("s") || this.prevKeys.get("arrowdown") || false;
      case "space": return this.prevKeys.get(" ") || false;
      case "click": return this.prevKeys.get("click") || false;
    }
  }

  /** Get normalized movement vector (-1 to 1) */
  getMovement(): { x: number; y: number } {
    let x = 0;
    let y = 0;

    if (this.isDown("left")) x -= 1;
    if (this.isDown("right")) x += 1;
    if (this.isDown("up")) y -= 1;
    if (this.isDown("down")) y += 1;

    // Touch input
    if (this.touchActive) {
      const sensitivity = 0.01;
      x += Math.max(-1, Math.min(1, this.touchDeltaX * sensitivity));
      y += Math.max(-1, Math.min(1, this.touchDeltaY * sensitivity));
    }

    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  getMousePosition(): { x: number; y: number } {
    return { x: this.mouseX, y: this.mouseY };
  }
}
