# Terminal Debugger UX Audit

**Date:** 2026-03-23
**File under audit:** `cli/bin/terminal.js` and `cli/lib/terminal/*.js`
**Method:** Source code analysis + `--script`/`--dump` output inspection

---

## Honest Limitations of This Audit

This audit was performed by an AI reading source code and text dumps. The following
aspects **cannot be reliably assessed without a human at a live terminal**:

- Actual perceived color contrast and readability
- Cursor blink timing feel (250ms — too fast? too slow?)
- Whether the focus indicator is visually prominent enough in practice
- Input latency and rendering flicker
- How the UI feels at different font sizes and terminal emulators
- Whether Unicode sextant/half-block characters render correctly in the user's terminal
- Truecolor (24-bit RGB) support — degrades silently on 256-color terminals
- Screen reader / accessibility behavior

---

## Issues

### CRITICAL: Help text overflows the command pane (scrolls past)

**Severity:** Critical

The help text is 42 lines. The command pane's visible output area is:
- 80x24 terminal: **5 lines** visible
- 120x40 terminal: **9 lines** visible
- 160x50 terminal: **11 lines** visible

The `CommandPane.print()` method stores all 42 lines in `outputLines`, but `render()`
only displays the last `outputRows` lines of the scrollback (fill from bottom up). So
when you type `help`, you see the **bottom** of the help text only. The top ~30 lines
scroll past instantly and are gone. There is **no scroll-up mechanism** in the command
pane — no Page Up, no scroll bar, no way to review earlier output.

The `maxOutput` is 200 lines, so the lines exist in memory, but the render method shows
only the tail, and there is no input handling for scrolling the output area.

**Fix proposal:**
1. Add Page Up / Page Down (or Shift+Up/Down) to scroll the command pane output.
2. Track a `scrollOffset` in `CommandPane` and use it in `render()`.
3. Show a scroll indicator (e.g., `[+32 more]`) when there is hidden content above.
4. Consider a pager mode: when output exceeds pane height, show `--More--` and wait
   for a keypress before printing the next screenful.
5. Alternatively, provide a `help <topic>` subcommand for shorter, targeted help.

### CRITICAL: Pane focus indicator is too subtle

**Severity:** Critical

The active pane is indicated by:
- Pane label on the horizontal divider rendered with `ESC[7m` (reverse video) for the
  active pane vs `dim` for inactive panes.
- The command pane's prompt changes from dim `> ` to green `> ` when focused.

That's it. There is:
- **No border color change** on the active pane (dividers are always dim).
- **No title bar or header** on each pane.
- **No bold/colored border** around the active pane.

The pane labels are tiny (` MEM `, ` DASM `, ` CMD `, ` MAP `) and sit on the horizontal
divider line — easily missed among all the other content. The reverse-video effect on
5 characters is the only visual difference between "this pane has focus" and "this pane
does not."

**Fix proposal:**
1. Change the divider border color/style for the active pane. For example, use bright
   white or yellow box-drawing characters for the borders of the active pane, while
   keeping inactive pane borders dim.
2. Add a visible "mode line" or header row at the top of each pane with the pane name,
   highlighted when active.
3. Use double-line box-drawing characters (e.g., `═`, `║`) for the active pane's borders.

### HIGH: No visible cursor in the memory pane from a human perspective

**Severity:** High

The memory pane does have a cursor with a 250ms blink cycle. When `flashOn` is true, the
cell at the cursor position is rendered with swapped foreground/background colors (inverse
video). When `flashOn` is false, it renders normally — **indistinguishable from any other
cell.**

Problems:
1. The cursor only flashes when the memory pane has focus *and* the simulation is paused
   (blink is driven by `tick()` which only calls `renderCursorFlash` when `!needsRender`).
   During simulation running, full redraws happen every frame, which toggle `flashOn` based
   on timing — but the 250ms blink competes with the 66ms render interval, creating an
   erratic blink pattern.
2. The cursor blinks **regardless of which pane has focus** — there is no code that
   suppresses the cursor flash when focus is on another pane. But the visual impact is
   subtle: it is just one character cell inverting colors among 224x224 cells.
3. The cursor position is never indicated with a persistent marker (crosshair, underline,
   bracket, etc.). If you look away and look back, you have to wait for the blink cycle
   to spot it.
4. **The dump output does not show cursor position.** The text dump has no concept of
   "which byte the cursor is on." This means automated testing and AI-mediated review
   cannot detect cursor state.

**Fix proposal:**
1. Use a persistent visual indicator: a bracket pair, underline, or distinct background
   color that is always visible, even on the off-phase of the blink.
2. Show cursor coordinates in the status bar (this is already done) but also add
   crosshair lines (a highlighted row and column) so the cursor is easy to find visually.
3. Suppress cursor flash when the memory pane does not have focus (currently wastes
   cycles and confuses the user about which pane is active).

### HIGH: No highlight line in the disassembler pane

**Severity:** High

The disassembler marks the PC position with a yellow `>` marker character. But:
1. There is no highlighted/selected line concept. When the disasm pane has focus and you
   press up/down arrows, the `disasmAddr` changes, but there is no visual cursor or
   highlighted current line to show what you are scrolling through.
2. The PC marker (`>`) only appears at the actual PC address. If you detach (`FREE` mode)
   and scroll away, there is no visible indicator of your scroll position.
3. All disassembly lines look the same (dim address, colored bytes, bold mnemonic) with
   no differentiation of the "currently selected" line.

**Fix proposal:**
1. Add a visible highlight bar (background color) on the "current line" — either the PC
   line when synced, or the top-of-view line when in FREE mode.
2. When the disasm pane has focus, show a cursor/selection indicator on the current
   scroll position.

### HIGH: No cursor indicator on the minimap pane

**Severity:** High

The minimap highlights the selected cell with yellow color (both in local and global mode).
However:
1. When the minimap pane has focus, there is no additional visual indicator (e.g., a
   blinking cursor, bracket, or distinct border) to distinguish "I'm selecting this cell"
   from "this cell happens to be highlighted."
2. In a mostly-dark board (inactive cells), the yellow highlight is visible. But on an
   active board with many colored cells, a single yellow cell can be hard to spot.
3. Arrow key movement in the minimap moves the board-level cell focus, which is the same
   behavior as in the memory pane with Ctrl+arrows. This dual binding is undocumented
   and may confuse users.

**Fix proposal:**
1. Add a blinking or bracketed cursor around the selected cell in the minimap.
2. Draw a small crosshair or border around the highlighted cell.

### HIGH: Keyboard affordances are not discoverable

**Severity:** High

The key bindings are:
- **Tab / Shift-Tab:** cycle pane focus (mentioned in `--help`, not on screen)
- **Memory pane:** arrows move cursor, Shift+arrows move 8x, Ctrl+arrows move cell focus,
  Space toggles run, `n` steps, `d` toggles disasm sync
- **Disasm pane:** up/down arrows scroll (only in FREE mode), Space/n/d same as memory
- **Minimap pane:** arrows move cell focus, `m` toggles local/global mode, Space/n
- **Command pane:** standard readline-like editing (Ctrl-A/E/K/U, arrows, history)

None of these are shown on screen. The only hint is `[d]etach`/`[d]sync` in the disasm
pane and `[m]ode` in the minimap. The memory pane and command pane show no key hints.

There is no on-screen legend, status bar key guide, or `?` overlay.

**Fix proposal:**
1. Add a key hint bar at the bottom of the screen or in the status line area, showing
   context-sensitive key bindings for the currently focused pane.
2. At minimum: `Tab:switch pane  Space:run/pause  n:step  ?:help`
3. Show pane-specific hints: Memory: `arrows:move  Ctrl+arrows:cell  Shift:fast`,
   Minimap: `m:mode  arrows:cell`, etc.

### MEDIUM: Command pane has no scrollback navigation

**Severity:** Medium

Related to the help text overflow issue, but applies generally: any command that produces
more output than the visible area (5-11 lines depending on terminal) loses its top lines
immediately. Commands affected include:
- `help` (42 lines)
- `presets` (9+ lines)
- `hexdump` with large N
- `census` with many entries
- `stack` with deep stacks

There are no Page Up/Down, scroll wheel, or any other mechanism to review past output.

**Fix proposal:** Same as the help text fix — add scroll support to the command pane.

### MEDIUM: The cursor is hidden globally (`hideCursor` in start())

**Severity:** Medium

The terminal's native cursor is hidden at startup (`ESC[?25l`) and never shown again
until exit. This means:
1. The command pane's input line has no visible text cursor — the only indicator is the
   reverse-video block character rendered manually at the cursor position.
2. If the command pane is not focused, there is no visible cursor anywhere on screen.
3. The rendered block cursor (ESC[7m + character) is only drawn when `hasFocus` is true
   for the command pane.

This is a defensible design choice for a TUI, but combined with the subtle focus indicator,
it makes it hard to know "where am I typing."

**Fix proposal:**
1. Consider showing the native terminal cursor (via `showCursor`) when the command pane
   has focus, positioned at the input line. This gives a real blinking cursor.
2. Alternatively, make the block cursor more prominent (e.g., bright color, underline).

### MEDIUM: No terminal size validation or graceful degradation

**Severity:** Medium

The layout code uses `process.stdout.columns || 120` and `process.stdout.rows || 40` as
defaults. The minimum right pane width is 34, and minimum bottom height is 6. But:
1. If the terminal is smaller than ~80x24, panes may overlap or render garbled content.
2. There is no warning message if the terminal is too small.
3. The `resize` event handler recalculates layout, but there is no check for minimum
   viable size.
4. The memory pane renders a 224x224 grid with a viewport — if the viewport is larger than
   224 in either dimension (very wide terminal), `scrollX/Y` calculations may underflow
   (`Math.min(224 - rect.width, ...)` goes negative).

**Fix proposal:**
1. Check terminal size on startup and on resize. If below minimum (e.g., 80x24), show a
   warning message instead of rendering garbled output.
2. Clamp viewport calculations to prevent negative scroll values.

### MEDIUM: Disasm pane shows wrong data when cell has not been selected by scheduler

**Severity:** Medium

The disasm pane reads memory via `this.memory.read(addr)`, which reads from the
memory-mapped address space of whichever cell the scheduler currently has selected
(`iOrig`/`jOrig`). But the disasm pane displays `Cell (i,j)` for a user-chosen cell.
If the scheduler's origin differs from the user's focus cell, the disassembly shows
**wrong data** — it shows the memory-mapped view from the scheduler's perspective, not
the focused cell's actual bytes.

(Note: `readCellRegisters` reads from storage correctly, so registers are accurate. Only
the disassembly byte reads via `mem.read()` are affected.)

**Fix proposal:** The disasm pane's `readFn` should use `readCellMemory()` or direct
storage access for the focused cell, not `this.memory.read()` which goes through the
memory mapper.

### LOW: Status bar content overlaps pane labels

**Severity:** Low

`renderStatusInfo()` writes the status text at `(hDivRow, 1)` — the same row where pane
labels are placed by `renderDividers()`. Since `renderDividers()` places labels at
`rect.col + 1` for each pane, and the status bar also starts at column 1, they write to
the same row. The status bar is rendered after dividers, so it overwrites the MEM and CMD
labels. The DASM and MAP labels survive because they start at `leftW + 2`.

**Fix proposal:** Offset the status bar to start after the MEM label, or place pane labels
on a different row (e.g., above the divider, as pane headers).

### LOW: `dump` command name collision

**Severity:** Low

The `dump` command in the switch statement matches both `case 'dump': case 'hexdump':
case 'hd':` (hex dump) AND `case 'screen-dump': case 'dump':` (screen dump). Since
the first `case 'dump'` catches it, typing `dump` always does a hex dump, not a screen
dump. The help text says `dump [FILE]` is "Plain-text screen dump" but it actually does
a hex dump. Only `screen-dump` triggers the screen dump.

**Fix proposal:** Remove the `dump` alias from one of the two commands, or rename them
to be unambiguous (e.g., `hd`/`hexdump` for hex, `sdump`/`screen` for screen dump).

### LOW: No visual feedback when switching panes

**Severity:** Low

Pressing Tab cycles the active pane, sets `needsRender = true`, and the next render will
update the pane labels. But there is no transition animation, sound, or flash. On a slow
render cycle (15fps cap), there could be a perceptible delay between pressing Tab and
seeing the focus change.

### LOW: `run` state is not visually prominent

**Severity:** Low

The status bar shows `RUN` in green or `PAU` in dim text. This is on the horizontal
divider line, competing with pane labels. When the simulation is running, the only
dynamic visual change is the minimap colors updating and the memory pane contents changing.
There is no pulsing border, no animated indicator, no prominent "RUNNING" banner.

---

## UX Checklist for Future Dogfooding Sessions

A human tester should evaluate the following with the actual terminal running:

### Focus and Navigation
- [ ] Can you tell which pane has focus at a glance? (Without reading the tiny label)
- [ ] Is it obvious what Tab does? Did you discover it naturally or need to read docs?
- [ ] When you switch panes, is the transition clear and immediate?
- [ ] Can you navigate back to a previous pane without cycling through all four?

### Cursors and Selection
- [ ] Can you see the memory pane cursor without staring?
- [ ] Is the cursor blink rate comfortable? (Currently 250ms)
- [ ] Can you find the cursor after scrolling the memory view?
- [ ] Does the disasm pane show where you are when scrolling in FREE mode?
- [ ] Does the minimap clearly show which cell is selected?

### Command Pane
- [ ] Can you read the full `help` output?
- [ ] Can you scroll back to see earlier command output?
- [ ] Is the input cursor visible? Can you tell where your text will appear?
- [ ] Does command history (up/down arrows) work as expected?
- [ ] Is the prompt color change (green when focused) noticeable?

### Information Density
- [ ] Is the status bar readable? Can you find RUN/PAUSE status quickly?
- [ ] Are the register values in the disasm pane readable at your font size?
- [ ] Is the memory pane's ASCII rendering readable, or does it look like noise?
- [ ] Are cell boundaries visible in the memory pane?

### Terminal Compatibility
- [ ] Test in: iTerm2, Terminal.app, kitty, alacritty, tmux, VS Code terminal
- [ ] Do sextant/half-block Unicode characters render correctly?
- [ ] Do 24-bit colors display correctly? (Some terminals only support 256)
- [ ] Does the layout survive terminal resize? (Try resizing while running)
- [ ] What happens at 80x24? At smaller sizes?

### Simulation Feedback
- [ ] Can you tell the simulation is running vs paused at a glance?
- [ ] Is the minimap useful for understanding board state?
- [ ] When you step, is the change visible in both memory and disasm panes?
- [ ] Does the speed setting produce noticeable differences?

### Error Handling
- [ ] What happens if you type an invalid command?
- [ ] What happens if you `load` a nonexistent file?
- [ ] What happens if you `cell 999,999` on a small board?
- [ ] What happens if the terminal is very small (e.g., 40x12)?

### Things an AI Cannot Test
- [ ] Overall "feel" — does it feel responsive and professional?
- [ ] Cognitive load — is there too much on screen at once?
- [ ] Discoverability — can a new user figure out the basics without reading docs?
- [ ] Color choices — do the colors work for colorblind users?
- [ ] Does the blinking cursor cause visual fatigue over long sessions?
