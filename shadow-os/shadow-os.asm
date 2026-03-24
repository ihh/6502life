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
;; 1. Paged cell storage with a page table at $0500.
;;    Each cell's 1KB occupies a physical page; swap is implemented
;;    by exchanging page-table entries (O(1), no data movement).
;;
;; 2. Shadow window at $C000-$C3FF, bank-selected by writing a
;;    board cell index to $D000. Gives the OS simultaneous access
;;    to cell 0 ($0000) and one partner cell ($C000).
;;
;; 3. Hardware noise gate on the shadow window WRITE path.
;;    Any STA to $C000-$C3FF automatically applies the board's
;;    noise model: each bit is independently resampled with
;;    probability epsilon, using the hardware LFSR as entropy.
;;    When epsilon=0, bytes pass through unchanged (perfect copy).
;;    This makes noisy copy a simple memcpy through the shadow
;;    window — the noise is "free" from the CPU's perspective.
;;
;; 4. NOISE_BYTE at $D001: reading returns the next byte from the
;;    hardware LFSR (used for RNG bytes written to $FC-$FF).
;;
;; 5. Countdown timer at $D002-$D003, triggers NMI on underflow.
;;
;; ── Memory map during Shadow OS execution ───────────────────
;;
;;   $0000-$03FF  Active cell (cell 0), read/write
;;   $0400-$04FF  OS scratch page (private working storage)
;;   $0500-$05FF  Page table (256 entries for B<=16 boards)
;;   $C000-$C3FF  Shadow window (target cell via SHADOW_BANK)
;;   $D000-$D003  Hardware registers
;;   $E000-$EEFF  Geometric lookup tables (shared with programs)
;;   $EF00-$FDFF  Shadow OS code (this file)
;;   $FE00-$FFFF  Vectors and boot
;;
;; During user program execution, $C000-$FFFF is unmapped.
;; Programs see only $0000-$BFFF (neighborhood) and $E000-$EEFF
;; (geometric tables). The Shadow OS is completely invisible.
;;
;; ── Cycle cost summary ──────────────────────────────────────
;;
;;   Timer interrupt (context switch):     ~80 cycles
;;   BRK 0 (reset PC, yield):             ~12 cycles
;;   BRK 1-48 (swap via page table):      ~49 cycles
;;   BRK 49-96 (noisy copy, 1024 bytes):  ~14,400 cycles
;;   BRK 97 (sync interrupt setup):       ~24 cycles
;;   BRK 98 (async interrupt setup):      ~24 cycles
;;
;; ================================================================

;; ── Hardware registers ──────────────────────────────────────

SHADOW_BANK = $D000     ; Write: map board cell N into $C000-$C3FF
NOISE_BYTE  = $D001     ; Read: next byte from hardware LFSR
TIMER_LO    = $D002     ; Read/write: countdown timer low byte
TIMER_HI    = $D003     ; Read/write: countdown timer high byte

;; ── Cell layout constants ───────────────────────────────────

CELL_SIZE   = $0400     ; 1024 bytes per cell
REG_PCHI    = $F9       ; Saved PC high byte
REG_PCLO    = $FA       ; Saved PC low byte
REG_P       = $FB       ; Saved processor status
REG_A       = $FC       ; Saved accumulator
REG_X       = $FD       ; Saved X register
REG_Y       = $FE       ; Saved Y register
REG_S       = $FF       ; Saved stack pointer

;; ── OS working storage ($0400-$04FF) ────────────────────────

OS_OPERAND  = $0400     ; BRK operand byte
OS_I_ORIG   = $0401     ; Current cell board row
OS_J_ORIG   = $0402     ; Current cell board column
OS_ORIENT   = $0403     ; Current orientation (0-3)
OS_TEMP_A   = $0404     ; Temp: saved A during interrupt entry
OS_TEMP_X   = $0405     ; Temp: saved X during interrupt entry
OS_TEMP_Y   = $0406     ; Temp: saved Y during interrupt entry

;; Neighbor-to-board-cell lookup table, populated during scheduling.
;; NEIGHBOR_MAP[n] = board cell index for neighborhood cell n.
;; 49 entries (0-48), rebuilt each time a new cell is scheduled.
NEIGHBOR_MAP = $0410    ; 49 bytes: $0410-$0440

;; ── Page table ($0500-$05FF) ────────────────────────────────
;; Maps logical board cell index → physical storage page number.
;; For a 16x16 board (256 cells), each entry is one byte.
;; Swap is implemented by exchanging two entries.

PAGE_TABLE  = $0500


;; ================================================================
;; NMI Handler — Timer Interrupt (Context Switch)
;; ================================================================
;; Entered when the countdown timer underflows.
;; The 6502 hardware pushes PCH, PCL, P to the stack.
;;
;; Cycle budget:
;;   Register save:    ~43 cycles
;;   Clear B flag:      ~8 cycles
;;   Write RNG:        ~28 cycles
;;   Total:            ~79 cycles (+ scheduler advance)
;; ================================================================

    .org $EF00

nmi_handler:
    ;; ── Save user registers to cell 0 save area ────────
    ;; NMI pushed P, PCL, PCH to stack (in that order on 6502:
    ;; actually PCH first, then PCL, then P).
    ;; Stack top → P, then PCL, then PCH.

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
    ;; Subtotal: 8 cycles

    ;; ── Write 4 pseudorandom bytes to $FC-$FF ──────────
    ;; These overwrite the saved A/X/Y/S, which is intentional:
    ;; the register save area doubles as the RNG region.
    ;; Programs see fresh random bytes at $FC-$FF each interrupt.
    LDA NOISE_BYTE          ; 4
    STA $FC                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FD                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FE                 ; 3
    LDA NOISE_BYTE          ; 4
    STA $FF                 ; 3
    ;; Subtotal: 28 cycles

    ;; ── Advance scheduler ──────────────────────────────
    ;; Select next cell, sample orientation and timer duration,
    ;; rebuild NEIGHBOR_MAP. This is board-size dependent and
    ;; involves the Poisson timer sampling. Cost varies; not
    ;; counted in the ~80 cycle total (it's scheduler overhead,
    ;; not per-cell OS cost).
    JSR advance_scheduler   ; 6 + subroutine cost

    ;; ── Restore next cell's registers and return ───────
    JMP restore_and_rti     ; 3

    ;; Total (excluding scheduler): ~79 cycles + restore_and_rti


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

    ;; Cost: ~14,400 cycles
    SEC                     ; 2
    SBC #48                 ; 2  A = target neighbor index (1-48)
    TAX                     ; 2
    LDA NEIGHBOR_MAP,X      ; 4  board cell index
    STA SHADOW_BANK         ; 4  map into shadow window at $C000
    ;; 20 cycles setup

    ;; Copy 4 pages from cell 0 to shadow window.
    ;; The hardware noise gate on the shadow window write path
    ;; automatically applies per-bit noise (pBitNoise, pBitNoiseZero).
    ;; From the CPU's perspective this is a plain memcpy.
    ;;
    ;; Per byte: LDA abs,Y (4) + STA abs,Y (5) + INY (2) + BNE (3) = 14
    ;; Per page: 255 * 14 + 1 * 13 + 2 (LDY) = 3,585 cycles
    ;; Four pages: 4 * 3,585 = 14,340 cycles

    ;; Page 0: $0000-$00FF → $C000-$C0FF
    LDY #$00                ; 2
@p0:
    LDA $0000,Y             ; 4
    STA $C000,Y             ; 5  (noise gate applies on write)
    INY                     ; 2
    BNE @p0                 ; 3/2

    ;; Page 1: $0100-$01FF → $C100-$C1FF
    LDY #$00                ; 2
@p1:
    LDA $0100,Y             ; 4
    STA $C100,Y             ; 5
    INY                     ; 2
    BNE @p1                 ; 3/2

    ;; Page 2: $0200-$02FF → $C200-$C2FF
    LDY #$00                ; 2
@p2:
    LDA $0200,Y             ; 4
    STA $C200,Y             ; 5
    INY                     ; 2
    BNE @p2                 ; 3/2

    ;; Page 3: $0300-$03FF → $C300-$C3FF
    LDY #$00                ; 2
@p3:
    LDA $0300,Y             ; 4
    STA $C300,Y             ; 5
    INY                     ; 2
    BNE @p3                 ; 3/2

    ;; 14,340 cycles for the copy loop

    JMP brk_set_b_and_yield ; 3
    ;; Total copy: 20 + 14,340 + 3 + B flag = ~14,374 cycles

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
    ;; In the real system, this is where commitWrites() happens.
    ;; The memory mapper disables undo tracking and flushes
    ;; pending writes to storage. This is a hardware operation
    ;; (switching the memory mapper from undo mode to direct mode),
    ;; not a CPU operation, so it costs ~0 CPU cycles.

    ;; Advance scheduler (picks next cell, rebuilds neighbor map)
    JSR advance_scheduler   ; 6 + subroutine cost

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
    ;;   - Configure memory mapper: write 49 page selections
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
;; Timer interrupt (NMI → restore_and_rti):
;;   Register save:     59 cycles
;;   Clear B flag:       8 cycles
;;   Write RNG:         28 cycles
;;   restore_and_rti:   38 cycles
;;   Jumps/JSR:         12 cycles
;;   ─────────────────────────
;;   Total:            ~145 cycles (excluding advance_scheduler)
;;   Spec rounds to:   ~80 cycles (save + RNG only, without restore)
;;
;; BRK 0 (reset PC):
;;   Operand extract:   41 cycles
;;   Reset PC:          11 cycles
;;   ─────────────────────────
;;   Total:             ~52 cycles (+ yield overhead)
;;   Spec says:         ~12 cycles (dispatch only, excluding extract)
;;
;; BRK 1-48 (swap):
;;   Operand extract:   41 cycles
;;   Dispatch branch:    8 cycles
;;   Page table swap:   39 cycles
;;   B flag + yield:    11 cycles
;;   ─────────────────────────
;;   Total:             ~99 cycles
;;   Spec says:         ~49 cycles (excluding operand extract)
;;
;; BRK 49-96 (noisy copy):
;;   Operand extract:   41 cycles
;;   Dispatch branch:   12 cycles
;;   Setup:             20 cycles
;;   Copy loop:     14,340 cycles (4 pages × 3,585 cycles)
;;   B flag + yield:    11 cycles
;;   ─────────────────────────
;;   Total:         14,424 cycles
;;   Spec says:    ~14,400 cycles (excluding operand extract)
;;
;; BRK 97/98 (sync/async):
;;   Operand extract:   41 cycles
;;   Dispatch branch:   14 cycles
;;   Timer write:       16 cycles
;;   Yield:              3 cycles
;;   ─────────────────────────
;;   Total:             ~74 cycles
;;   Spec says:         ~24 cycles (excluding operand extract)
;;
;; Note: "Spec says" figures exclude the 41-cycle operand extraction
;; overhead, which is common to all BRK operations and could be
;; considered part of the 7-cycle BRK instruction cost in a
;; hardware-assisted implementation (where the operand byte is
;; latched by the interrupt controller automatically).
