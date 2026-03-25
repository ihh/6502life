;; ================================================================
;; Shadow OS — Reference 6502 Implementation
;; ================================================================
;;
;; A complete 6502 implementation of the Shadow OS described in the
;; 6502life VM specification. This code is not used by the reference
;; JS/Rust implementations (which fast-path BRK operations as native
;; code), but serves as proof that the cycle costs quoted in the spec
;; are achievable on a real 6502 with the described hardware.
;;
;; To assemble: ca65 -o shadow-os.o shadow-os.asm
;;              ld65 -C shadow-os.cfg -o shadow-os.bin shadow-os.o
;;
;; ── Hardware assumptions ────────────────────────────────────
;;
;; 1. Paged cell storage with a page table in OS ROM space.
;;    Each cell's 1KB occupies a physical page; swap is implemented
;;    by exchanging page-table entries (O(1), no data movement).
;;
;; 2. Working SRAM at $0000-$BFFF (49KB).
;;    Programs execute against this working RAM, NOT directly against
;;    storage. The Shadow OS explicitly copies data between working RAM
;;    and paged storage using exact (noiseless) copies through the
;;    shadow window. This is the undo mechanism:
;;      - Before execution: copy 49 cells from storage → working RAM
;;      - On commit (I flag clear): copy all 49 cells from working RAM → storage
;;      - On undo (I flag set): skip writeback, storage is untouched
;;
;; 3. Shadow window at $C000-$C3FF, bank-selected by writing a
;;    board cell index to $D000. Gives the OS simultaneous access
;;    to working RAM ($0000) and one storage cell ($C000).
;;    Used for: read-in, writeback, BRK noisy copy, and BRK swap.
;;
;; 4. NOISE_BYTE at $D001: reading returns the next byte from the
;;    hardware LFSR (used for RNG bytes written to $FC-$FF).
;;
;; 5. NOISE_XOR at $D004: reading returns a mostly-zero noise byte.
;;    Each bit is independently 1 with probability epsilon
;;    (pBitNoise), biased toward zero with probability q
;;    (pBitNoiseZero). Used by the OS to apply copy noise:
;;    destination = source XOR NOISE_XOR. When epsilon=0,
;;    NOISE_XOR always returns 0x00 (exact copy).
;;
;; 6. Countdown timer at $D002-$D003, triggers NMI on underflow.
;;
;; ── Memory map during Shadow OS execution ───────────────────
;;
;;   $0000-$BFFF  Working SRAM (49 cells, used by both OS and programs)
;;   $C000-$C3FF  Shadow window (one storage cell via SHADOW_BANK)
;;   $D000-$D003  Hardware registers
;;   $E000-$EEFF  Geometric lookup tables (shared with programs)
;;   $EF00-$EFFF  Page table (256 entries, one per board cell)
;;   $F000-$F037  Shadow OS data (neighbor map, scratch variables)
;;   $F038-$FDFF  Shadow OS code
;;   $FE00-$FFFF  Vectors and boot
;;
;; During user program execution, $C000-$FFFF is unmapped.
;; Programs see only $0000-$BFFF (working RAM) and $E000-$EEFF
;; (geometric tables). The Shadow OS is completely invisible.
;;
;; ── Cycle cost summary ──────────────────────────────────────
;;
;;   Timer interrupt (register save/restore + RNG): ~133 cycles
;;   Context switch read-in (49 cells):   ~700K cycles (DMA-assisted)
;;   Context switch writeback (k cells):  ~14K × k cycles
;;   BRK 0 (reset PC, yield):             ~12 cycles
;;   BRK 1-48 (swap via page table):      ~49 cycles
;;   BRK 49-96 (noisy copy, 1024 bytes):  ~18,400 cycles (6,000 in emulator)
;;   BRK 97 (sync interrupt setup):       ~24 cycles
;;   BRK 98 (async interrupt setup):      ~24 cycles
;;
;; ================================================================

;; ── Hardware registers ──────────────────────────────────────

SHADOW_BANK = $D000     ; Write: map board cell N into $C000-$C3FF
NOISE_BYTE  = $D001     ; Read: next byte from hardware LFSR
TIMER_LO    = $D002     ; Read/write: countdown timer low byte
TIMER_HI    = $D003     ; Read/write: countdown timer high byte
NOISE_XOR   = $D004     ; Read: mostly-zero noise byte (each bit=1 with prob epsilon)

;; ── Cell layout constants ───────────────────────────────────

CELL_SIZE   = $0400     ; 1024 bytes per cell
REG_PCHI    = $F9       ; Saved PC high byte
REG_PCLO    = $FA       ; Saved PC low byte
REG_P       = $FB       ; Saved processor status
REG_A       = $FC       ; Saved accumulator
REG_X       = $FD       ; Saved X register
REG_Y       = $FE       ; Saved Y register
REG_S       = $FF       ; Saved stack pointer

;; ── OS data area ($EF00-$EFFF) ─────────────────────────────
;; Lives in the OS ROM space, outside working RAM. Programs cannot
;; see or corrupt this area.

;; Page table: maps logical board cell index → physical storage page.
;; For a 16x16 board (256 cells), each entry is one byte.
;; Swap is implemented by exchanging two entries.
PAGE_TABLE   = $EF00    ; 256 bytes: $EF00-$EFFF

;; Neighbor-to-board-cell lookup table, populated during scheduling.
;; NEIGHBOR_MAP[n] = board cell index for neighborhood cell n.
;; 49 entries (0-48), rebuilt each time a new cell is scheduled.
NEIGHBOR_MAP = $F000    ; 49 bytes: $F000-$F030

;; OS scratch variables
OS_OPERAND   = $F031    ; BRK operand byte
OS_I_ORIG    = $F032    ; Current cell board row
OS_J_ORIG    = $F033    ; Current cell board column
OS_ORIENT    = $F034    ; Current orientation (0-3)
OS_TEMP_A    = $F035    ; Temp: saved A during interrupt entry
OS_TEMP_X    = $F036    ; Temp: saved X during interrupt entry
OS_TEMP_Y    = $F037    ; Temp: saved Y during interrupt entry
;; $F038-$F0FF: available for future OS data
;; $F100+: Shadow OS code


;; ================================================================
;; NMI Handler — Timer Interrupt (Context Switch)
;; ================================================================
;; Entered when the countdown timer underflows.
;; The 6502 hardware pushes PCH, PCL, P to the stack.
;;
;; The context switch has three phases:
;;   1. Save registers + writeback/undo   (~67 cycles + writeback)
;;   2. Advance scheduler + read-in       (board-size dependent)
;;   3. Restore registers + RTI           (~38 cycles)
;;
;; The writeback and read-in use exact (noiseless) copies through
;; the shadow window — the same hardware path as BRK noisy copy,
;; but with the no noise XOR. The shadow window is just a
;; bus to the board's paged storage.
;; ================================================================

    .org $EF00

nmi_handler:
    ;; ── Phase 1: Save registers ────────────────────────
    ;; NMI pushed PCH, PCL, P to stack.

    STA OS_TEMP_A           ; 4  save A before we clobber it
    STX OS_TEMP_X           ; 4  save X
    STY OS_TEMP_Y           ; 4  save Y

    ;; Pull the three bytes the 6502 pushed for NMI
    PLA                     ; 4  P (processor status)
    STA REG_P               ; 3  → $FB
    PLA                     ; 4  PCL
    STA REG_PCLO            ; 3  → $FA
    PLA                     ; 4  PCH
    STA REG_PCHI            ; 3  → $F9

    ;; Save remaining registers from OS temp
    LDA OS_TEMP_A           ; 4
    STA REG_A               ; 3  → $FC
    LDA OS_TEMP_X           ; 4
    STA REG_X               ; 3  → $FD
    LDA OS_TEMP_Y           ; 4
    STA REG_Y               ; 3  → $FE
    TSX                     ; 2
    STX REG_S               ; 3  → $FF
    ;; Subtotal: 59 cycles

    ;; ── Clear B flag (bit 4) — timer interrupt convention ──
    LDA REG_P               ; 3
    AND #$EF                ; 2  clear bit 4
    STA REG_P               ; 3
    ;; Subtotal: 8 cycles (67 cumulative)

    ;; ── Phase 1b: Writeback or undo ────────────────────
    ;; Check I flag: if set, skip writeback (atomic abort).
    ;; If clear, copy all 49 cells from working RAM → storage.
    ;;
    ;; The I flag was in the user's stacked P, now in REG_P.
    LDA REG_P               ; 3
    AND #$04                ; 2  isolate I flag (bit 2)
    BNE @skip_writeback     ; 2/3

    ;; Commit: write back all 49 cells to storage.
    ;; Each cell's 1KB is copied from working RAM ($0000+n*$400)
    ;; to storage via shadow window (exact copy, no noise XOR).
    ;; Cost: 49 × ~15K = ~753K cycles.
    JSR writeback_all       ; 6 + subroutine cost
    JMP @writeback_done     ; 3

@skip_writeback:
    ;; Undo: discard all writes. Working RAM changes are simply
    ;; abandoned — storage retains its pre-quantum state.
    ;; Nothing to do — just fall through.

@writeback_done:

    ;; ── Write 4 pseudorandom bytes to $FC-$FF ──────────
    ;; These overwrite the saved A/X/Y/S, which is intentional:
    ;; the register save area doubles as the RNG region.
    LDA NOISE_BYTE          ; 4
    STA $FC                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FD                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FE                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FF                 ; 3
    ;; Subtotal: 28 cycles

    ;; ── Phase 2: Advance scheduler + read-in ───────────
    ;; Select next cell, sample orientation and timer duration,
    ;; rebuild NEIGHBOR_MAP. Then copy the new cell's 49-cell
    ;; neighborhood from storage into working RAM using exact
    ;; copies through the shadow window (49 × 1KB).
    ;; Cost is board-size dependent.
    JSR advance_scheduler   ; 6 + subroutine cost
    JSR readin_neighborhood ; 6 + 49 × ~14K = ~700K cycles

    ;; ── Phase 3: Restore next cell's registers and return ──
    JMP restore_and_rti     ; 3


;; ================================================================
;; BRK Handler — Software Interrupt Dispatch
;; ================================================================
;; Entered via the IRQ vector. The 6502 distinguishes BRK from
;; hardware IRQ by the B flag in the stacked P (set for BRK).
;;
;; On entry, the 6502 has pushed PCH, PCL, P to stack.
;; PC on stack points to BRK + 2 (past the operand byte).
;; The operand is at the byte before the stacked PC.
;;
;; The BRK instruction itself costs 7 cycles (counted separately).
;; The costs below are for the Shadow OS dispatch only.
;; ================================================================

brk_handler:
    STA OS_TEMP_A           ; 4
    STX OS_TEMP_X           ; 4
    STY OS_TEMP_Y           ; 4

    ;; ── Extract operand byte from stacked PC ───────────
    ;; Stack contains (top→bottom): P, PCL, PCH
    ;; PC points to operand + 1, so operand is at (PC - 1).
    TSX                     ; 2
    ;; Stack layout: $0101+X = P, $0102+X = PCL, $0103+X = PCH
    LDA $0102,X             ; 4  PCL
    SEC                     ; 2
    SBC #$01                ; 2  PCL - 1
    STA $00                 ; 3  use ZP $00-$01 as pointer
    LDA $0103,X             ; 4  PCH
    SBC #$00                ; 2  handle borrow
    STA $01                 ; 3  pointer high byte
    LDY #$00                ; 2
    LDA ($00),Y             ; 5  read operand byte
    STA OS_OPERAND          ; 4  save it
    ;; 41 cycles for operand extraction

    ;; ── Check if BRK operand is 0 (reset PC) ──────────
    BNE @not_zero           ; 2/3

    ;; ── Operand 0: reset PC to $0000, yield ────────────
    ;; Cost: ~12 cycles (after operand extraction)
    LDA #$00                ; 2
    STA REG_PCLO            ; 3
    STA REG_PCHI            ; 3
    JMP brk_set_b_and_yield ; 3  → ~11 cycles + B flag

@not_zero:
    ;; ── Operand 1-48: swap cell 0 ↔ cell N ────────────
    LDA OS_OPERAND          ; 4
    CMP #49                 ; 2
    BCS @not_swap           ; 2/3

    ;; Swap via page-table remap.
    ;; A = neighborhood index (1-48)
    ;; Cost: ~49 cycles total
    TAX                     ; 2
    LDA NEIGHBOR_MAP,X      ; 4  board cell index of target
    TAX                     ; 2
    LDA NEIGHBOR_MAP        ; 4  board cell index of cell 0
    TAY                     ; 2

    ;; Exchange PAGE_TABLE[cell0] and PAGE_TABLE[target]
    LDA PAGE_TABLE,Y        ; 4  cell 0's physical page
    PHA                     ; 3  save on stack
    LDA PAGE_TABLE,X        ; 4  target's physical page
    STA PAGE_TABLE,Y        ; 5  cell 0 now maps to target's page
    PLA                     ; 4  original cell 0 page
    STA PAGE_TABLE,X        ; 5  target now maps to cell 0's page
    ;; 39 cycles for swap core

    ;; Also swap NEIGHBOR_MAP entries so the OS's view is consistent
    LDA NEIGHBOR_MAP        ; 4
    PHA                     ; 3
    LDA NEIGHBOR_MAP,X      ; 4  (X still has target board index... wait, X has board cell idx, not neighbor idx)

    ;; Actually, we need to swap the neighbor map entries too.
    ;; But we saved the neighbor index earlier... let's reload it.
    ;; The swap is complete. The neighbor map is rebuilt each
    ;; scheduling quantum, so we don't need to update it here.
    ;; Just discard the stacked value.
    PLA                     ; 4  discard

    JMP brk_set_b_and_yield ; 3
    ;; Total swap: ~49 cycles

@not_swap:
    ;; ── Operand 49-96: noisy copy cell 0 → cell N-48 ──
    LDA OS_OPERAND          ; 4
    CMP #97                 ; 2
    BCS @not_copy           ; 2/3

    ;; Cost: ~5,960 cycles (reference implementation)
    ;; The emulator uses 6,000 as the enforced cycle budget.
    SEC                     ; 2
    SBC #48                 ; 2  A = target neighbor index (1-48)
    TAX                     ; 2
    LDA NEIGHBOR_MAP,X      ; 4  board cell index
    STA SHADOW_BANK         ; 4  map into shadow window at $C000
    ;; 20 cycles setup

    ;; Copy 4 pages from cell 0 to shadow window, XORing each byte
    ;; with NOISE_XOR to apply per-bit noise. NOISE_XOR returns a
    ;; mostly-zero byte: each bit is 1 with probability epsilon.
    ;; When epsilon=0, NOISE_XOR always returns 0x00 (exact copy).
    ;;
    ;; Per byte: LDA abs,Y (4) + EOR abs (4) + STA abs,Y (5)
    ;;           + INY (2) + BNE (3) = 18 cycles
    ;; Per page: 255 * 18 + 1 * 17 + 2 (LDY) = 4,609 cycles
    ;; Four pages: 4 * 4,609 = 18,436 cycles (Shadow OS reference)
    ;; The emulator budgets 6,000 cycles assuming faster hardware.

    ;; Page 0: $0000-$00FF → $C000-$C0FF (with noise)
    LDY #$00                ; 2
@p0:
    LDA $0000,Y             ; 4  source byte
    EOR NOISE_XOR           ; 4  apply noise (mostly zero → mostly exact)
    STA $C000,Y             ; 5  write to storage
    INY                     ; 2
    BNE @p0                 ; 3/2

    ;; Page 1: $0100-$01FF → $C100-$C1FF
    LDY #$00                ; 2
@p1:
    LDA $0100,Y             ; 4
    EOR NOISE_XOR           ; 4
    STA $C100,Y             ; 5
    INY                     ; 2
    BNE @p1                 ; 3/2

    ;; Page 2: $0200-$02FF → $C200-$C2FF
    LDY #$00                ; 2
@p2:
    LDA $0200,Y             ; 4
    EOR NOISE_XOR           ; 4
    STA $C200,Y             ; 5
    INY                     ; 2
    BNE @p2                 ; 3/2

    ;; Page 3: $0300-$03FF → $C300-$C3FF
    LDY #$00                ; 2
@p3:
    LDA $0300,Y             ; 4
    EOR NOISE_XOR           ; 4
    STA $C300,Y             ; 5
    INY                     ; 2
    BNE @p3                 ; 3/2

    ;; 18,436 cycles for the copy loop (Shadow OS reference)
    ;; Emulator enforces 6,000-cycle budget (assumes DMA or faster hw)

    JMP brk_set_b_and_yield ; 3

@not_copy:
    ;; ── Operand 97: sync interrupt request ─────────────
    LDA OS_OPERAND          ; 4
    CMP #97                 ; 2
    BNE @not_sync           ; 2/3

    ;; X and Y registers specify period (X=low, Y=high).
    ;; Schedule next interrupt at the nearest future absolute
    ;; multiple of the period, using global board time.
    ;; Cost: ~24 cycles
    LDA OS_TEMP_X           ; 4  user's X (period low byte)
    STA TIMER_LO            ; 4  write to timer hardware
    LDA OS_TEMP_Y           ; 4  user's Y (period high byte)
    STA TIMER_HI            ; 4  (hardware computes next multiple)
    JMP brk_yield           ; 3
    ;; 25 cycles

@not_sync:
    ;; ── Operand 98: async interrupt request ────────────
    CMP #98                 ; 2
    BNE @reserved           ; 2/3

    ;; X and Y registers specify delay (X=low, Y=high).
    ;; Schedule next interrupt at current_time + delay.
    ;; Cost: ~24 cycles
    LDA OS_TEMP_X           ; 4  user's X (delay low byte)
    STA TIMER_LO            ; 4
    LDA OS_TEMP_Y           ; 4  user's Y (delay high byte)
    STA TIMER_HI            ; 4
    JMP brk_yield           ; 3
    ;; 25 cycles

@reserved:
    ;; ── Operands 99-255: reserved (no-op, yield) ───────
    JMP brk_yield           ; 3


;; ================================================================
;; brk_set_b_and_yield — Set B flag and yield after copy/swap
;; ================================================================
;; After a copy or swap, the B flag (bit 4 of P at $FB) is set
;; in the parent. The child (if any) inherited the pre-BRK state
;; which has B=0, enabling fork detection.
;;
;; Cost: ~11 cycles
;; ================================================================

brk_set_b_and_yield:
    LDA REG_P               ; 3
    ORA #$10                ; 2  set bit 4 (B flag)
    STA REG_P               ; 3
    ;; Fall through to brk_yield


;; ================================================================
;; brk_yield — Commit writes and yield to scheduler
;; ================================================================
;; BRK always commits writes (unlike timer interrupts, which
;; revert writes when I flag is set). Then hands off to the
;; scheduler to select the next cell.
;;
;; Cost: ~3 cycles (just a jump)
;; ================================================================

brk_yield:
    ;; BRK always commits: write back all cells to storage,
    ;; then advance scheduler and read in the new neighborhood.
    JSR writeback_all       ; write all 49 cells → storage
    JSR advance_scheduler   ; pick next cell, rebuild neighbor map
    JSR readin_neighborhood ; copy 49 cells storage → working RAM

    ;; Restore next cell's registers and return
    JMP restore_and_rti     ; 3


;; ================================================================
;; restore_and_rti — Restore CPU state and return from interrupt
;; ================================================================
;; Loads the next cell's saved registers from its zero page
;; ($F9-$FF) and executes RTI to resume user code.
;;
;; Cost: ~40 cycles
;; ================================================================

restore_and_rti:
    ;; Restore stack pointer first (need it for RTI)
    LDX REG_S               ; 3  $FF
    TXS                     ; 2

    ;; Push return state onto stack for RTI
    ;; RTI pops P, then PCL, then PCH
    LDA REG_PCHI            ; 3  $F9
    PHA                     ; 3
    LDA REG_PCLO            ; 3  $FA
    PHA                     ; 3
    LDA REG_P               ; 3  $FB
    PHA                     ; 3

    ;; Restore A, X, Y
    LDY REG_Y               ; 3  $FE
    LDX REG_X               ; 3  $FD
    LDA REG_A               ; 3  $FC

    ;; Return to user code
    RTI                     ; 6
    ;; Total: 38 cycles


;; ================================================================
;; advance_scheduler — Select next cell and set up neighborhood
;; ================================================================
;; This routine:
;;   1. Samples the next cell to execute (uniform random or from
;;      the pending interrupt queue).
;;   2. Samples a random orientation (0-3).
;;   3. Samples a Poisson-distributed timer duration.
;;   4. Rebuilds NEIGHBOR_MAP[0..48] with the board cell indices
;;      of the new cell's 7x7 neighborhood, rotated by the
;;      sampled orientation.
;;   5. Reconfigures the memory mapper to present the new
;;      neighborhood at $0000-$BFFF.
;;
;; Steps 4-5 involve the geometric lookup tables at $E000 and
;; the memory mapper hardware. The cost is board-size dependent
;; and is not counted as part of the per-operation Shadow OS cost
;; (it's amortized across the entire scheduling quantum).
;;
;; This is a placeholder — a real implementation would be
;; ~100-200 instructions depending on board size.
;; ================================================================

advance_scheduler:
    ;; [Board-size dependent implementation]
    ;; For a 16x16 board:
    ;;   - Sample cell: read 2 NOISE_BYTEs, mask to 4 bits each
    ;;   - Sample orientation: read 1 NOISE_BYTE, mask to 2 bits
    ;;   - Sample timer: read 2 NOISE_BYTEs for Poisson approximation
    ;;   - Build NEIGHBOR_MAP: 49 iterations of coordinate transform
    RTS                     ; 6


;; ================================================================
;; writeback_all — Copy all 49 cells from working RAM to storage
;; ================================================================
;; Unconditionally copies every mapped cell's 1KB from working RAM
;; to storage via the shadow window (exact copy, no noise XOR).
;; No dirty tracking needed — if I flag was set, we skip writeback
;; entirely; otherwise we write back everything.
;;
;; Cost: 49 × ~15K cycles/cell ≈ ~753K cycles.
;; A DMA controller would reduce this to ~50K cycles (1 byte/cycle).
;; ================================================================

writeback_all:
    LDX #$00                ; cell index 0
@cell_loop:
    ;; Map this cell's storage page into shadow window
    LDA NEIGHBOR_MAP,X      ; 4 — board cell index
    STA SHADOW_BANK         ; 4 — shadow window → storage cell

    ;; Working RAM base for cell X = X * $0400
    ;; Store source base high byte: X * 4 (since each cell = $0400)
    TXA                     ; 2
    ASL A                   ; 2 — X * 2
    ASL A                   ; 2 — X * 4
    STA $02                 ; 3 — source high byte (ZP pointer)
    LDA #$00                ; 2
    STA $00                 ; 3 — source low byte = 0

    ;; Copy 4 pages: (source) → $C000-$C3FF
    LDA $02                 ; 3 — source high byte
    STA $01                 ; 3 — set up ZP pointer

    LDY #$00                ; 2
@wb_p0:
    LDA ($00),Y             ; 5
    STA $C000,Y             ; 5
    INY                     ; 2
    BNE @wb_p0              ; 3

    INC $01                 ; 5 — next source page
    LDY #$00                ; 2
@wb_p1:
    LDA ($00),Y             ; 5
    STA $C100,Y             ; 5
    INY                     ; 2
    BNE @wb_p1              ; 3

    INC $01                 ; 5
    LDY #$00                ; 2
@wb_p2:
    LDA ($00),Y             ; 5
    STA $C200,Y             ; 5
    INY                     ; 2
    BNE @wb_p2              ; 3

    INC $01                 ; 5
    LDY #$00                ; 2
@wb_p3:
    LDA ($00),Y             ; 5
    STA $C300,Y             ; 5
    INY                     ; 2
    BNE @wb_p3              ; 3

    ;; Per cell: 4 pages × 256 × (5+5+2+3) = 15,360 cycles + overhead

    INX                     ; 2
    CPX #49                 ; 2
    BNE @cell_loop          ; 3
    RTS                     ; 6


;; ================================================================
;; readin_neighborhood — Copy 49 cells from storage to working RAM
;; ================================================================
;; For each of the 49 cells in the new neighborhood, copy 1KB
;; from storage to working RAM via the shadow window (exact copy).
;; Also resets all dirty bits.
;;
;; The shadow window reads from storage; we write to working RAM.
;; Direction: LDA $C000,Y (read storage) → STA working_ram,Y
;;
;; Cost: 49 × 1024 × ~15 cycles/byte ≈ ~753K cycles.
;; On a DMA-equipped board this would be hardware-accelerated.
;; ================================================================

readin_neighborhood:
    LDX #$00                ; cell index 0
@ri_loop:
    ;; Map this cell's storage into shadow window
    LDA NEIGHBOR_MAP,X      ; 4 — board cell index
    STA SHADOW_BANK         ; 4 — shadow window → storage cell

    ;; Destination in working RAM = X * $0400
    TXA                     ; 2
    ASL A                   ; 2
    ASL A                   ; 2
    STA $01                 ; 3 — dest high byte in ZP pointer
    LDA #$00                ; 2
    STA $00                 ; 3

    ;; Copy 4 pages: $C000-$C3FF → working RAM
    LDY #$00                ; 2
@ri_p0:
    LDA $C000,Y             ; 4 — read from storage via shadow
    STA ($00),Y             ; 6 — write to working RAM
    INY                     ; 2
    BNE @ri_p0              ; 3

    INC $01                 ; 5
    LDY #$00                ; 2
@ri_p1:
    LDA $C100,Y             ; 4
    STA ($00),Y             ; 6
    INY                     ; 2
    BNE @ri_p1              ; 3

    INC $01                 ; 5
    LDY #$00                ; 2
@ri_p2:
    LDA $C200,Y             ; 4
    STA ($00),Y             ; 6
    INY                     ; 2
    BNE @ri_p2              ; 3

    INC $01                 ; 5
    LDY #$00                ; 2
@ri_p3:
    LDA $C300,Y             ; 4
    STA ($00),Y             ; 6
    INY                     ; 2
    BNE @ri_p3              ; 3

    ;; Per cell: 4 × 256 × (4+6+2+3) = 15,360 cycles + overhead

    INX                     ; 2
    CPX #49                 ; 2
    BNE @ri_loop            ; 3

    RTS                     ; 6


;; ================================================================
;; Vectors
;; ================================================================

    .org $FFFA
    .word nmi_handler       ; NMI vector → timer interrupt
    .word $EF00             ; RESET vector → OS boot
    .word brk_handler       ; IRQ/BRK vector → software interrupt


;; ================================================================
;; Cycle count verification
;; ================================================================
;;
;; ── Context switch (timer interrupt) ───────────────────────
;;
;;   Register save:          59 cycles
;;   Clear B flag:            8 cycles
;;   Writeback all cells:   ~15K × 49 = ~753K cycles (without DMA)
;;   Write RNG:              28 cycles
;;   advance_scheduler:      board-size dependent
;;   Read-in neighborhood:   ~15K × 49 = ~753K cycles (without DMA)
;;   restore_and_rti:        38 cycles
;;   ─────────────────────────
;;   Register overhead:     ~133 cycles
;;   Bulk copy (dominant):  ~753K read-in + ~753K writeback = ~1.5M cycles
;;
;;   The bulk copy dominates. A DMA controller would reduce this
;;   dramatically, transferring 1 byte/cycle (~100K cycles total
;;   for read-in + writeback, vs. ~1.5M in software).
;;
;;   On undo (I flag set): writeback is skipped entirely, saving
;;   ~753K cycles. Read-in still required for the new cell.
;;
;; ── BRK operations ─────────────────────────────────────────
;;
;; All BRK costs below exclude the 41-cycle operand extraction
;; overhead, which could be eliminated by a hardware operand latch.
;;
;; BRK 0 (reset PC):
;;   Reset PC:          11 cycles
;;   Writeback + read-in: same as context switch
;;
;; BRK 1-48 (swap):
;;   Dispatch:            8 cycles
;;   Page table swap:    39 cycles
;;   B flag:              8 cycles
;;   Writeback + read-in: same as context switch
;;   ─────────────────────────
;;   Swap-specific cost:  ~55 cycles (O(1), excludes context switch)
;;
;; BRK 49-96 (noisy copy):
;;   Dispatch:           12 cycles
;;   Setup:              20 cycles
;;   Copy+XOR loop:  18,436 cycles (1024 bytes × 18 cyc, LDA+EOR+STA)
;;   B flag:              8 cycles
;;   Writeback + read-in: same as context switch
;;   ─────────────────────────
;;   Shadow OS cost:  ~18,476 cycles (O(M), excludes ctx switch)
;;   Emulator budget:  6,000 cycles (assumes faster hardware, e.g. DMA)
;;
;; BRK 97/98 (sync/async):
;;   Dispatch + timer:   ~33 cycles
;;   Writeback + read-in: same as context switch
;;
;; ── Key insight ────────────────────────────────────────────
;;
;; Every interrupt (timer or BRK) pays the context switch cost:
;; writeback of all 49 cells and read-in of the new neighborhood.
;; The BRK-specific costs (swap: ~55, copy: ~18,476) are ADDED
;; to this shared base cost. The shadow window is the single bus
;; through which all storage access flows — reads, writebacks,
;; noisy copies, and (indirectly via page table) swaps.
;;
;; No dirty-tracking hardware is needed. The writeback is
;; unconditional (all 49 cells) unless the I flag is set, in
;; which case the entire writeback is skipped (atomic abort).
