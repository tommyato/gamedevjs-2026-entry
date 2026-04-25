type InputKey = "left" | "right" | "up" | "down" | "space" | "click";

type NavDirection = "up" | "down" | "left" | "right";

type MovementVector = {
  x: number;
  y: number;
};

type GamepadButtonState = {
  space: boolean;
  click: boolean;
  /** Cancel — gamepad B (button 1). Used to back out of menus / modals. */
  cancel: boolean;
};

type GamepadNavState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

/** Threshold the analog stick must cross to count as a nav-direction press. */
const NAV_STICK_THRESHOLD = 0.6;

type GamepadConnectionChangeHandler = (connected: boolean) => void;

export class Input {
  private readonly keys = new Map<string, boolean>();
  private readonly prevKeys = new Map<string, boolean>();
  private gamepadMovement: MovementVector = { x: 0, y: 0 };
  private readonly gamepadButtons: GamepadButtonState = {
    space: false,
    click: false,
    cancel: false,
  };
  private readonly prevGamepadButtons: GamepadButtonState = {
    space: false,
    click: false,
    cancel: false,
  };
  /** D-pad + left-stick-as-direction state, edge-detected each frame
   *  to drive menu cursor navigation (kept separate from gamepadMovement
   *  so player-controls aren't double-counted via getMovement()). */
  private readonly gamepadNav: GamepadNavState = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  private readonly prevGamepadNav: GamepadNavState = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  private onGamepadConnectionChange: GamepadConnectionChangeHandler | null = null;
  private lastGamepadSignature: string | null = null;
  private mouseX = 0;
  private mouseY = 0;
  private joystickVector: MovementVector = { x: 0, y: 0 };
  private readonly isTouchCapable = typeof window !== "undefined" && "ontouchstart" in window;
  private joystickTouchId: number | null = null;
  private jumpTouchId: number | null = null;
  private joystickOrigin: MovementVector = { x: 0, y: 0 };
  private joystickRadius = 44;
  private touchControlsRoot: HTMLElement | null = null;
  private touchLeftZone: HTMLElement | null = null;
  private touchJoystick: HTMLElement | null = null;
  private touchJoystickThumb: HTMLElement | null = null;
  private touchJump: HTMLElement | null = null;

  init(canvas: HTMLElement, onGamepadConnectionChange?: GamepadConnectionChangeHandler) {
    this.onGamepadConnectionChange = onGamepadConnectionChange ?? null;
    this.touchControlsRoot = document.getElementById("touch-controls");
    this.touchLeftZone = document.getElementById("touch-left-zone");
    this.touchJoystick = document.getElementById("touch-joystick");
    this.touchJoystickThumb = document.getElementById("touch-joystick-thumb");
    this.touchJump = document.getElementById("touch-jump");

    window.addEventListener("keydown", (event) => {
      this.keys.set(event.key.toLowerCase(), true);
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(event.key.toLowerCase())) {
        event.preventDefault();
      }
    });

    window.addEventListener("keyup", (event) => {
      this.keys.set(event.key.toLowerCase(), false);
    });

    window.addEventListener("mousedown", (event) => {
      this.keys.set("click", true);
      this.mouseX = event.clientX;
      this.mouseY = event.clientY;
    });

    window.addEventListener("mouseup", () => {
      this.keys.set("click", false);
    });

    window.addEventListener("mousemove", (event) => {
      this.mouseX = event.clientX;
      this.mouseY = event.clientY;
    });

    if (this.isTouchCapable) {
      this.setupTouchControls();
    } else {
      this.touchControlsRoot?.classList.add("hidden");
    }

    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  private setupTouchControls() {
    this.touchControlsRoot?.classList.remove("hidden");
    this.touchControlsRoot?.classList.add("hidden");

    window.addEventListener("touchstart", (event) => {
      this.keys.set("click", true);
      const firstTouch = event.touches[0];
      if (firstTouch) {
        this.mouseX = firstTouch.clientX;
        this.mouseY = firstTouch.clientY;
      }
    }, { passive: true });

    window.addEventListener("touchend", () => {
      this.keys.set("click", false);
    }, { passive: true });

    window.addEventListener("touchcancel", () => {
      this.keys.set("click", false);
      this.releaseJoystick();
      this.releaseJump();
    }, { passive: true });

    this.touchLeftZone?.addEventListener("touchstart", (event) => {
      if (this.joystickTouchId !== null) {
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }

      event.preventDefault();
      this.joystickTouchId = touch.identifier;
      this.joystickOrigin = { x: touch.clientX, y: touch.clientY };
      this.updateJoystickVisual(touch.clientX, touch.clientY, 0, 0);
    }, { passive: false });

    this.touchLeftZone?.addEventListener("touchmove", (event) => {
      const touch = this.findTouch(event.touches, this.joystickTouchId);
      if (!touch) {
        return;
      }

      event.preventDefault();
      const dx = touch.clientX - this.joystickOrigin.x;
      const dy = touch.clientY - this.joystickOrigin.y;
      const distance = Math.hypot(dx, dy);
      const clamped = distance > this.joystickRadius ? this.joystickRadius / distance : 1;
      const clampedX = dx * clamped;
      const clampedY = dy * clamped;

      this.joystickVector = {
        x: clampedX / this.joystickRadius,
        y: clampedY / this.joystickRadius,
      };
      this.updateJoystickVisual(
        this.joystickOrigin.x,
        this.joystickOrigin.y,
        clampedX,
        clampedY
      );
    }, { passive: false });

    this.touchLeftZone?.addEventListener("touchend", (event) => {
      if (!this.findTouch(event.changedTouches, this.joystickTouchId)) {
        return;
      }

      event.preventDefault();
      this.releaseJoystick();
    }, { passive: false });

    this.touchLeftZone?.addEventListener("touchcancel", (event) => {
      if (!this.findTouch(event.changedTouches, this.joystickTouchId)) {
        return;
      }

      event.preventDefault();
      this.releaseJoystick();
    }, { passive: false });

    this.touchJump?.addEventListener("touchstart", (event) => {
      if (this.jumpTouchId !== null) {
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }

      event.preventDefault();
      this.jumpTouchId = touch.identifier;
      this.keys.set(" ", true);
      this.touchJump?.classList.add("pressed");
    }, { passive: false });

    this.touchJump?.addEventListener("touchend", (event) => {
      if (!this.findTouch(event.changedTouches, this.jumpTouchId)) {
        return;
      }

      event.preventDefault();
      this.releaseJump();
    }, { passive: false });

    this.touchJump?.addEventListener("touchcancel", (event) => {
      if (!this.findTouch(event.changedTouches, this.jumpTouchId)) {
        return;
      }

      event.preventDefault();
      this.releaseJump();
    }, { passive: false });
  }

  private findTouch(touchList: TouchList, identifier: number | null): Touch | null {
    if (identifier === null) {
      return null;
    }

    for (let index = 0; index < touchList.length; index += 1) {
      const touch = touchList.item(index);
      if (touch && touch.identifier === identifier) {
        return touch;
      }
    }

    return null;
  }

  private updateJoystickVisual(originX: number, originY: number, offsetX: number, offsetY: number) {
    if (!this.touchJoystick || !this.touchJoystickThumb) {
      return;
    }

    this.touchJoystick.style.left = `${originX}px`;
    this.touchJoystick.style.top = `${originY}px`;
    this.touchJoystick.classList.add("active");
    this.touchJoystickThumb.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  }

  private releaseJoystick() {
    this.joystickTouchId = null;
    this.joystickVector = { x: 0, y: 0 };
    this.touchJoystick?.classList.remove("active");
    if (this.touchJoystickThumb) {
      this.touchJoystickThumb.style.transform = "translate(0px, 0px)";
    }
  }

  private releaseJump() {
    this.jumpTouchId = null;
    this.keys.set(" ", false);
    this.touchJump?.classList.remove("pressed");
  }

  update() {
    this.gamepadMovement = { x: 0, y: 0 };
    this.gamepadButtons.space = false;
    this.gamepadButtons.click = false;
    this.gamepadButtons.cancel = false;
    this.gamepadNav.up = false;
    this.gamepadNav.down = false;
    this.gamepadNav.left = false;
    this.gamepadNav.right = false;

    const navigatorGamepads = typeof navigator !== "undefined" && "getGamepads" in navigator
      ? navigator.getGamepads()
      : null;
    const gamepad = navigatorGamepads
      ? [navigatorGamepads[0], navigatorGamepads[1], navigatorGamepads[2], navigatorGamepads[3]]
          .find((candidate) => candidate && candidate.connected) || null
      : null;
    const signature = gamepad ? `${gamepad.index}:${gamepad.id}:${gamepad.mapping}` : null;

    if (signature !== this.lastGamepadSignature) {
      const wasConnected = this.lastGamepadSignature !== null;
      const isConnected = signature !== null;
      this.lastGamepadSignature = signature;

      if (this.onGamepadConnectionChange) {
        if (!wasConnected && isConnected) {
          this.onGamepadConnectionChange(true);
        } else if (wasConnected && !isConnected) {
          this.onGamepadConnectionChange(false);
        } else if (wasConnected && isConnected) {
          this.onGamepadConnectionChange(true);
        }
      }
    }

    if (!gamepad) {
      return;
    }

    const leftStickX = Math.abs(gamepad.axes[0] || 0) < 0.15 ? 0 : (gamepad.axes[0] || 0);
    const leftStickY = Math.abs(gamepad.axes[1] || 0) < 0.15 ? 0 : (gamepad.axes[1] || 0);

    this.gamepadMovement.x += leftStickX;
    this.gamepadMovement.y += leftStickY;

    const dpadUp = Boolean(gamepad.buttons[12]?.pressed);
    const dpadDown = Boolean(gamepad.buttons[13]?.pressed);
    const dpadLeft = Boolean(gamepad.buttons[14]?.pressed);
    const dpadRight = Boolean(gamepad.buttons[15]?.pressed);

    if (dpadUp)    this.gamepadMovement.y -= 1;
    if (dpadDown)  this.gamepadMovement.y += 1;
    if (dpadLeft)  this.gamepadMovement.x -= 1;
    if (dpadRight) this.gamepadMovement.x += 1;

    // Menu nav directions: d-pad OR left stick crossing the nav threshold.
    // Threshold (0.6) is higher than the deadzone (0.15) so a held stick
    // edge produces exactly one menu step — matches console UX, where
    // half-press doesn't move the cursor.
    this.gamepadNav.up    = dpadUp    || leftStickY < -NAV_STICK_THRESHOLD;
    this.gamepadNav.down  = dpadDown  || leftStickY >  NAV_STICK_THRESHOLD;
    this.gamepadNav.left  = dpadLeft  || leftStickX < -NAV_STICK_THRESHOLD;
    this.gamepadNav.right = dpadRight || leftStickX >  NAV_STICK_THRESHOLD;

    // A button (0) → activate. B button (1) → cancel/back.
    // (Previously B was an alias for activate; per universal polish rule 4
    // gamepad B is reserved for menu cancel.)
    this.gamepadButtons.space = Boolean(gamepad.buttons[0]?.pressed);
    this.gamepadButtons.cancel = Boolean(gamepad.buttons[1]?.pressed);
    this.gamepadButtons.click = Boolean(gamepad.buttons[9]?.pressed);
  }

  endFrame() {
    for (const [key, value] of this.keys) {
      this.prevKeys.set(key, value);
    }

    this.prevGamepadButtons.space = this.gamepadButtons.space;
    this.prevGamepadButtons.click = this.gamepadButtons.click;
    this.prevGamepadButtons.cancel = this.gamepadButtons.cancel;
    this.prevGamepadNav.up = this.gamepadNav.up;
    this.prevGamepadNav.down = this.gamepadNav.down;
    this.prevGamepadNav.left = this.gamepadNav.left;
    this.prevGamepadNav.right = this.gamepadNav.right;
  }

  isDown(key: InputKey): boolean {
    switch (key) {
      case "left":
        return this.keys.get("a") || this.keys.get("arrowleft") || false;
      case "right":
        return this.keys.get("d") || this.keys.get("arrowright") || false;
      case "up":
        return this.keys.get("w") || this.keys.get("arrowup") || false;
      case "down":
        return this.keys.get("s") || this.keys.get("arrowdown") || false;
      case "space":
        // Treat Enter as an alias for Space across menus + gameplay so
        // keyboard activation works on every menu (per universal polish
        // rule 4) without forking activate-vs-jump bindings.
        return this.keys.get(" ") || this.keys.get("enter") || this.gamepadButtons.space || false;
      case "click":
        return this.keys.get("click") || this.gamepadButtons.click || false;
    }
  }

  justPressed(key: InputKey): boolean {
    return this.isDown(key) && !this.wasDown(key);
  }

  /**
   * Edge-detected directional press for menu navigation. Aggregates
   * keyboard arrow keys / WASD with gamepad d-pad and left-stick
   * threshold crossings. Used by MenuNavigation; deliberately separate
   * from the `up/down/left/right` InputKey path so player movement
   * (which adds the analog stick separately via getMovement()) doesn't
   * double-count stick deflection.
   */
  justPressedDir(direction: NavDirection): boolean {
    const kbdNow  = this.keyboardDirDown(direction);
    const kbdPrev = this.keyboardDirWasDown(direction);
    const padNow  = this.gamepadNav[direction];
    const padPrev = this.prevGamepadNav[direction];
    return (kbdNow && !kbdPrev) || (padNow && !padPrev);
  }

  /**
   * Edge-detected cancel/back. Aggregates Esc + gamepad B (button 1).
   * Used by MenuNavigation to close modals.
   */
  justPressedCancel(): boolean {
    const escNow  = Boolean(this.keys.get("escape"));
    const escPrev = Boolean(this.prevKeys.get("escape"));
    return (escNow && !escPrev) || (this.gamepadButtons.cancel && !this.prevGamepadButtons.cancel);
  }

  private keyboardDirDown(direction: NavDirection): boolean {
    switch (direction) {
      case "left":  return Boolean(this.keys.get("a") || this.keys.get("arrowleft"));
      case "right": return Boolean(this.keys.get("d") || this.keys.get("arrowright"));
      case "up":    return Boolean(this.keys.get("w") || this.keys.get("arrowup"));
      case "down":  return Boolean(this.keys.get("s") || this.keys.get("arrowdown"));
    }
  }

  private keyboardDirWasDown(direction: NavDirection): boolean {
    switch (direction) {
      case "left":  return Boolean(this.prevKeys.get("a") || this.prevKeys.get("arrowleft"));
      case "right": return Boolean(this.prevKeys.get("d") || this.prevKeys.get("arrowright"));
      case "up":    return Boolean(this.prevKeys.get("w") || this.prevKeys.get("arrowup"));
      case "down":  return Boolean(this.prevKeys.get("s") || this.prevKeys.get("arrowdown"));
    }
  }

  private wasDown(key: InputKey): boolean {
    switch (key) {
      case "left":
        return this.prevKeys.get("a") || this.prevKeys.get("arrowleft") || false;
      case "right":
        return this.prevKeys.get("d") || this.prevKeys.get("arrowright") || false;
      case "up":
        return this.prevKeys.get("w") || this.prevKeys.get("arrowup") || false;
      case "down":
        return this.prevKeys.get("s") || this.prevKeys.get("arrowdown") || false;
      case "space":
        return this.prevKeys.get(" ") || this.prevKeys.get("enter") || this.prevGamepadButtons.space || false;
      case "click":
        return this.prevKeys.get("click") || this.prevGamepadButtons.click || false;
    }
  }

  getMovement(): MovementVector {
    let x = 0;
    let y = 0;

    if (this.isDown("left")) {
      x -= 1;
    }
    if (this.isDown("right")) {
      x += 1;
    }
    if (this.isDown("up")) {
      y -= 1;
    }
    if (this.isDown("down")) {
      y += 1;
    }

    if (this.isTouchCapable) {
      x += this.joystickVector.x;
      y += this.joystickVector.y;
    }

    x += this.gamepadMovement.x;
    y += this.gamepadMovement.y;

    return {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
    };
  }

  getMousePosition(): MovementVector {
    return { x: this.mouseX, y: this.mouseY };
  }

  isTouchDevice(): boolean {
    return this.isTouchCapable;
  }

  setTouchControlsVisible(visible: boolean) {
    if (!this.isTouchCapable || !this.touchControlsRoot) {
      return;
    }

    this.touchControlsRoot.classList.toggle("hidden", !visible);
    if (!visible) {
      this.releaseJoystick();
      this.releaseJump();
    }
  }
}
