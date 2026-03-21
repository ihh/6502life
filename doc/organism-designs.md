# Novel Replicator Designs for 6502life

## Context

All existing replicators go extinct by 2M interrupts on an 8x8 board at the
default noise level (epsilon = 1/2048, ~4 bit errors per 1024-byte BRK copy).
The experiment log identifies two destruction mechanisms:

1. **Copy noise**: BRK noisy-copy flips ~4 bits per cell copy
2. **Cross-contamination**: random cells executing garbage write into neighbors

Cross-contamination is the dominant killer. Even at zero copy noise, most
replicators die because garbage cells overwrite their code.

### Key mechanics for defense

- **SEI + timer interrupt**: When I flag is set and a timer interrupt fires,
  all writes from that scheduling are reverted. BRK (software interrupt) always
  commits regardless of I flag. This means SEI protects partial work from
  committing, but cannot protect against writes from OTHER cells (which happen
  during those cells' scheduling, not ours).
- **P register persistence**: When a cell is scheduled, P is loaded from $FB.
  A noisy copy copies $FB, so the child inherits the parent's I flag state
  (modulo copy noise).
- **Garbage cells and I flag**: Random cells have random $FB, so ~50% start
  with I set. But garbage cells often hit BRK ($00 bytes) quickly, and BRK
  always commits, so the I flag offers only partial protection.
- **Replication speed**: The most successful strategy is high copy rate with
  minimal genome. The directional-spreader (10 bytes) and brk-spreader-2x
  (26 bytes) perform best at zero noise.

---

## Design 1: Nano Replicator

**Strategy**: Absolute minimal genome. 5 bytes. Uses BRK $F5 to copy forward
(cell 1). Orientation is randomized each scheduling, so "forward" covers all
four cardinal directions over time.

**Rationale**: With only 40 bits of critical code, the probability of a lethal
mutation per BRK noisy copy is just ~1.9%. Compare to the brk-spreader's
15 bytes (120 bits, ~5.7% lethal rate) or brk-spreader-2x's 26 bytes (208
bits, ~9.7%).

```asm
; Nano Replicator: 5-byte minimal BRK spreader
; Always copies forward. Orientation randomizes direction each scheduling.
@start:
BRK
.byte $F5           ; noisy copy origin -> cell 1 (forward)
CLC                 ; clear carry for unconditional branch
BCC @start          ; always taken
```

**Assembled**: `00 F5 18 90 FB` (5 bytes)

**Analysis**:
- Code size: 5 bytes (40 bits)
- Copies per scheduling: 1
- Error probability per copy: 1 - (2047/2048)^40 = 1.94%
- The child inherits PC from $F9:$FA. Our PC points to $0000, so the child
  starts correctly. The noisy copy copies all 1024 bytes including $F9:$FA.
- Only copies forward (cell 1), not all 4 directions. Over many schedulings,
  the random orientation means all directions are covered equally.
- Weakness: only 1 copy per scheduling (vs 2 for brk-spreader-2x).
- Weakness: no mobility -- stays in place, vulnerable to being overwritten.

**Viability estimate**: Promising. The tiny genome gives the best possible
copy fidelity. The question is whether 1 copy/scheduling is enough to outpace
destruction. On an 8x8 board, once the replicator fills ~50% of cells, it
should be self-sustaining since most random execution hits replicator cells.

**Interest/promise**: 4/5

---

## Design 2: Nano Replicator 2x

**Strategy**: Like the nano, but two copies per scheduling cycle.

```asm
; Nano Replicator 2x: two BRK copies per scheduling
@start:
BRK
.byte $F5           ; copy forward (cell 1)
BRK
.byte $F5           ; copy forward again (possibly different orientation?
                    ; No: orientation is fixed per scheduling. Same cell.)
CLC
BCC @start
```

Wait -- orientation is fixed within a single scheduling. Both BRK copies go
to the same cell. That is useless. We need self-modifying code to pick different
targets, which bloats the genome. Let me instead use two different fixed cells.

```asm
; Nano Replicator 2x: copy to cell 1 and cell 2
; Cell 1 = forward (N), Cell 2 = right (E) in current orientation
@start:
BRK
.byte $F5           ; noisy copy origin -> cell 1
BRK
.byte $F6           ; noisy copy origin -> cell 2
CLC
BCC @start
```

**Assembled**: `00 F5 00 F6 18 90 FA` (7 bytes)

**Analysis**:
- Code size: 7 bytes (56 bits)
- Copies per scheduling: 2 (to forward and right neighbors)
- Error probability per copy: 1 - (2047/2048)^56 = 2.70%
- Covers 2 of 4 cardinal directions per scheduling. Over many schedulings,
  all directions are covered since orientation rotates randomly.
- Tradeoff: 40% more genome than nano but 2x replication rate.

**Viability estimate**: Good. The 2x copy rate should significantly help
overcome the initial colonization hurdle. Once ~30% of cells are copies,
the population should be self-sustaining.

**Interest/promise**: 5/5

---

## Design 3: Nano Replicator 4x

**Strategy**: Four BRK copies covering all cardinal neighbors in one scheduling.

```asm
; Nano Replicator 4x: copy to all 4 cardinal neighbors
@start:
BRK
.byte $F5           ; copy to cell 1 (forward/N)
BRK
.byte $F6           ; copy to cell 2 (right/E)
BRK
.byte $F7           ; copy to cell 3 (back/S)
BRK
.byte $F8           ; copy to cell 4 (left/W)
CLC
BCC @start
```

**Assembled**: `00 F5 00 F6 00 F7 00 F8 18 90 F6` (11 bytes -- wait, let me
recount. BRK=$00, $F5, BRK=$00, $F6, BRK=$00, $F7, BRK=$00, $F8, CLC=$18,
BCC=$90, offset. That's 11 bytes.)

Actually, after each BRK, the controller processes the interrupt and returns.
The next scheduling of this cell resumes at PC+2. So:
- First scheduling: BRK $F5 fires, copies to cell 1. PC becomes $0002.
- Second scheduling: BRK $F6 fires, copies to cell 2. PC becomes $0004.
- Third scheduling: BRK $F7 fires, copies to cell 3. PC becomes $0006.
- Fourth scheduling: BRK $F8 fires, copies to cell 4. PC becomes $0008.
- Fifth scheduling: CLC, BCC @start. PC back to $0000.

So it takes 5 scheduling events to complete one cycle, copying to all 4
neighbors. That is 4 copies per 5 schedulings = 0.8 copies/scheduling.

Hmm, but the nano-2x gets 2 copies per 2 schedulings = 1.0 copies/scheduling
(first scheduling: BRK $F5, second: BRK $F6, third: CLC+BCC, starts over --
wait, the CLC+BCC is after the second BRK, so it executes in the third
scheduling? No. After BRK $F6, PC = $0004. Third scheduling starts at $0004:
CLC ($18), BCC back to $0000. But BCC is not a software interrupt, so the CPU
keeps executing until either BRK or timer. So in the third scheduling, CLC
executes (1 cycle), then BCC executes (2-3 cycles), then we are at $0000: BRK
$F5 fires. So the third scheduling actually does: CLC, BCC, BRK $F5. That is
1 copy. Fourth scheduling: BRK $F6. Etc.

So the cycle is: scheduling 1: BRK $F5 (1 copy). Scheduling 2: BRK $F6 (1
copy). Scheduling 3: CLC + BCC + BRK $F5 (1 copy). Scheduling 4: BRK $F6
(1 copy). And so on. The CLC+BCC adds one scheduling with a copy. So the
steady state is 1 copy per scheduling.

For the 4x version: scheduling 1-4 each fire one BRK (4 copies). Scheduling 5:
CLC + BCC + BRK $F5 (1 copy). Scheduling 6: BRK $F6 (1 copy). Etc. So steady
state is still 1 copy per scheduling.

Wait, I am overcomplicating this. After BRK fires, PC advances by 2 (past BRK +
operand). The cell is not scheduled again immediately -- a random cell is chosen
next. When this cell IS scheduled again, it resumes at the saved PC.

For the nano 1x (`00 F5 18 90 FB`):
- Scheduling A: PC=$0000. BRK $F5 fires. PC becomes $0002. 1 copy.
- Scheduling B: PC=$0002. CLC (1 cycle), BCC @start (3 cycles) -> PC=$0000.
  Then BRK $F5 fires. PC becomes $0002. 1 copy. Timer may or may not fire
  before BCC completes, but typically BCC completes before the timer (timer
  mean is ~4096 cycles, BCC takes 3 cycles).

So the nano gets 1 copy per scheduling. Always.

For the nano 2x (`00 F5 00 F6 18 90 FA`):
- Scheduling A: PC=$0000. BRK $F5 fires. PC=$0002. 1 copy.
- Scheduling B: PC=$0002. BRK $F6 fires. PC=$0004. 1 copy.
- Scheduling C: PC=$0004. CLC, BCC -> PC=$0000. BRK $F5 fires. PC=$0002.
  1 copy.
- Scheduling D: PC=$0002. BRK $F6. 1 copy.

So the nano 2x still gets 1 copy per scheduling! The extra BRK just alternates
which direction it copies to. The CLC+BCC+BRK all happen in one scheduling.

This means multiple BRK copies in sequence do NOT increase the per-scheduling
copy rate. Each BRK terminates the scheduling event.

For the brk-spreader-2x preset, it uses self-modifying code to patch BOTH BRK
operands, then fires BRK. The first BRK ends the scheduling. The second BRK
fires in the next scheduling. So it also gets 1 copy per scheduling, but it
patches both targets at once during a single scheduling before the first BRK.

So the ONLY way to get >1 copy per scheduling is to... you can't. BRK always
ends the scheduling event.

This means genome size is the primary variable, not copies-per-scheduling. All
BRK-based replicators get exactly 1 copy per scheduling (assuming the BRK fires
before the timer).

The real advantage of brk-spreader-2x over brk-spreader is that it randomizes
direction each scheduling (reading $FC/$FD for two different directions), then
the two BRK copies fire on consecutive schedulings. But the randomization
happens only when $FC/$FD are written (at the start of each scheduling). After
the first BRK fires, the cell is scheduled again with fresh RNG... but the
patched operands from the previous scheduling are still in place. The second BRK
fires with the old operand. Then on the NEXT scheduling, fresh RNG patches both
again.

So brk-spreader-2x's pattern is: scheduling 1 (fresh RNG) -> patches both
operands -> BRK 1 fires (1 copy). Scheduling 2 (fresh RNG, but ignored until
loop restarts) -> BRK 2 fires with old operand (1 copy). Scheduling 3 -> BNE/BEQ
back to start, fresh RNG -> patches both -> BRK 1 fires (1 copy). And so on.

The net effect: 1 copy per scheduling, alternating between two randomly chosen
directions. The nano-2x (`BRK $F5, BRK $F6`) does the same but with fixed
relative directions (forward, right) rotated by random orientation.

Given this analysis, the key metric is:
**copies per scheduling = 1 for all BRK-based replicators, regardless of how
many BRK instructions are in the code.**

The differentiators are:
1. **Genome size** (error vulnerability)
2. **Direction coverage** (do you copy to 1, 2, or 4 directions?)
3. **Mobility** (do you also swap to move around?)

Revised analysis for all designs:

```asm
; Nano Replicator 4x: copy to all 4 cardinal neighbors
; Takes 5 schedulings to cycle (4 BRKs + 1 loop-back)
; Effective rate: 4 copies per 5 schedulings = 0.8 copies/scheduling
; BUT the loop-back scheduling also fires BRK on the next iteration
; So steady state: 1 copy/scheduling, cycling through all 4 directions
@start:
BRK
.byte $F5           ; copy to cell 1
BRK
.byte $F6           ; copy to cell 2
BRK
.byte $F7           ; copy to cell 3
BRK
.byte $F8           ; copy to cell 4
CLC
BCC @start
```

**Assembled**: `00 F5 00 F6 00 F7 00 F8 18 90 F6` (11 bytes)

**Analysis**:
- Code size: 11 bytes (88 bits)
- Copies per scheduling: 1 (cycles through all 4 directions)
- Error probability per copy: 1 - (2047/2048)^88 = 4.21%
- Copies to ALL 4 cardinal neighbors deterministically (doesn't rely on
  random orientation to cover all directions).
- Tradeoff: slightly worse fidelity than nano-1x, but guaranteed
  omni-directional coverage.
- The 4x coverage means on an 8x8 board, a single copy can
  immediately reach all 4 neighbors, faster colonization.

**Viability estimate**: Moderate. The 11-byte genome is still small but 2x
the nano. The guaranteed 4-direction coverage is valuable for initial
colonization. However, orientation already randomizes direction for the nano,
so the benefit may be marginal over many schedulings.

**Interest/promise**: 3/5

---

## Design 4: SEI Fortress 2x

**Strategy**: SEI + two-direction BRK copy. The SEI ensures that if a timer
interrupt catches us mid-setup (patching operands), the writes are reverted.
This prevents half-patched code from persisting.

**Insight**: The brk-spreader-2x uses self-modifying code to patch two BRK
operands. If a timer interrupt fires BETWEEN the two STA instructions, one
operand is patched and the other is stale. This creates an inconsistent state.
SEI prevents this by reverting all writes on timer interrupt.

Moreover, the child inherits I=1 in $FB (since our P register has I set when
saved), giving it the same protection from its first scheduling.

```asm
; SEI Fortress 2x: atomic setup + BRK copy
@start:
SEI                 ; protect setup writes from timer interrupt
LDA $FC             ; RNG
AND #$03
CLC
ADC #$F5            ; $F5-$F8
STA @brk1+1         ; patch first BRK operand
LDA $FD             ; second RNG
AND #$03
CLC
ADC #$F5
STA @brk2+1         ; patch second BRK operand
@brk1:
BRK
.byte $F5           ; first copy (patched)
@brk2:
BRK
.byte $F5           ; second copy (patched)
CLC
BCC @start
```

**Assembled**: `78 A5FC 2903 18 69F5 8514 A5FD 2903 18 69F5 8516 00F5 00F5 18 90E6` (26 bytes)

**Analysis**:
- Code size: 26 bytes (208 bits)
- Copies per scheduling: 1 (alternates between two random directions)
- Error probability per copy: 1 - (2047/2048)^208 = 9.68%
- The SEI makes the setup phase atomic. If timer fires before BRK,
  all writes (the STA patches) are reverted. Cell tries again next time.
- Child inherits I=1, getting the same atomic protection.
- This is identical to brk-spreader-2x in behavior but with SEI.
- The genome is large (26 bytes). At ~10% error per copy, viability
  at epsilon=1/2048 is questionable.

**Viability estimate**: Low. The 26-byte genome is too large for the
1/2048 error rate. The SEI protection is nice but doesn't address the
fundamental Eigen error catastrophe problem. The nano replicator's 5-byte
genome is a much better bet.

**Interest/promise**: 2/5

---

## Design 5: Walking Nano

**Strategy**: Combine the nano replicator with mobility. Copy forward, then
swap forward. This creates a spreading wavefront -- the replicator leaves
copies behind as it moves.

```asm
; Walking Nano: copy forward then move forward
; Leaves a copy behind at each step
@start:
BRK
.byte $F5           ; noisy copy origin -> cell 1 (forward)
BRK
.byte $01           ; swap origin <-> cell 1 (move forward)
CLC
BCC @start
```

**Assembled**: `00 F5 00 01 18 90 FA` (7 bytes)

**Analysis**:
- Code size: 7 bytes (56 bits)
- Pattern: scheduling 1: copy forward (1 copy). Scheduling 2: swap forward
  (move into copy, original stays behind). Scheduling 3: CLC+BCC+BRK $F5
  (copy forward from new position). Etc.
- Effective rate: 1 copy per 2 schedulings that matter (copy + swap alternate).
  Actually: copy fires on scheduling 1, swap fires on scheduling 2, copy fires
  on scheduling 3 (after CLC+BCC loop), swap fires on scheduling 4. So 1 copy
  per 2 schedulings.
- Error probability per copy: 1 - (2047/2048)^56 = 2.70%
- The mobility means the replicator is harder to pin down and destroy.
  If a neighbor overwrites the original position, the replicator has already
  moved away. And the copy at the old position is another replicator.
- This is similar to the directional-spreader preset (10 bytes) but smaller.
  The directional-spreader does copy, swap, copy per cycle (3 BRKs, 10 bytes).

**Viability estimate**: Good. Mobility helps survival. The directional-spreader
survives well at zero noise. At epsilon=1/2048, the 7-byte genome gives much
better fidelity than the directional-spreader's 10 bytes.

**Interest/promise**: 4/5

---

## Design 6: SEI Shield (Atomic LDA/STA Copy)

**Strategy**: Use LDA/STA loops for perfect-fidelity copying (zero noise).
SEI ensures partial copies are reverted on timer interrupt. BRK commits the
completed copy.

**Rationale**: The fundamental problem with BRK noisy-copy is copy noise.
LDA/STA copies are perfect. The problem with existing LDA/STA copiers
(spreader, mini-spreader) is that partial copies commit when the timer
interrupts mid-loop. SEI solves this: timer interrupt during the copy loop
reverts ALL writes (including the partial copy). Only when the copy completes
and BRK fires do the writes commit atomically.

```asm
; SEI Shield: atomic perfect-fidelity copy
; Lives at $E0, copies $E0-$FA (27 bytes) to random neighbor.
; SEI prevents partial copies from committing on timer interrupt.
.org $00E0
@start:
SEI                 ; timer interrupt will revert all writes
LDA $FC             ; RNG byte
AND #$03            ; 0-3
CLC
ADC #$01            ; 1-4 (cardinal neighbor)
ASL
ASL                 ; high byte: $04/$08/$0C/$10
STA @st+2           ; patch STA high byte in copy loop
LDY #$1A            ; 27 bytes ($E0+$1A=$FA)
@lp:
LDA $E0,Y           ; read own code at $E0+Y
@st:
STA $04E0,Y         ; write to target (high byte patched)
DEY
BPL @lp             ; Y=$00..$1A inclusive
; Copy complete. BRK commits writes (BRK ignores I flag).
BRK
.byte $01           ; operand: swap with cell 1 (move)
BMI @start          ; always taken (DEY past 0 sets N)
```

**Analysis**:
- Code size: 26 bytes at $E0-$F9
- Copies per scheduling: depends on whether the 27-byte LDA/STA loop completes
  before the timer fires. The loop does 27 iterations of LDA+STA+DEY+BPL =
  ~16 cycles each = ~432 cycles. Plus setup ~20 cycles = ~450 cycles total.
  Timer mean is ~4096 cycles. Probability of timer firing before completion:
  P(timer < 450) = 1 - (1-1/177)^(450/16) ~ 1 - (0.9944)^28 ~ 14%.
  So ~86% of schedulings complete the copy and commit.
- When timer fires mid-copy: SEI causes ALL writes to be reverted. No
  partial copy. Clean retry next scheduling.
- Copy fidelity: PERFECT (LDA/STA, no noise channel).
- The copy writes to the target's page 0 only. It copies $E0-$FA, which
  includes the code ($E0-$F8) and PC save ($F9-$FA). It does NOT copy $FB
  (P register) or $FC-$FF (RNG/registers). So the child's P flag is not
  set by the copy.
- The BRK $01 swap moves us forward after copying. Both original position
  (now containing a copy) and new position (us) can replicate.
- Issue: child's $FB is NOT written by the LDA/STA copy (which only copies
  $E0-$FA). The child's $FB retains whatever random value was there.
  So the child does NOT inherit I flag protection.

**Viability estimate**: High. This is the mini-spreader-sei but with a crucial
fix: the SEI actually makes the LDA/STA copy atomic. The original mini-spreader
commits partial copies because SEI alone doesn't help when the timer fires
(SEI reverts writes, which includes the PARTIAL copy -- this is actually what
we want). Wait, this IS what mini-spreader-sei does. Let me check the
difference.

Looking at mini-spreader-sei.asm: it's essentially the same design, but uses
`BRK .byte $01` after the loop for commit, and `BMI @start` for looping.
The difference is that mini-spreader-sei survived to 1M but died by 2M (from
the experiment log). This design is the same code.

The issue is cross-contamination: other cells' writes into our memory still
happen (on THEIR schedulings, not ours). SEI only protects our own writes.

**Interest/promise**: 3/5 (identical to existing mini-spreader-sei)

---

## Design 7: Dual-Copy Nano (LDA/STA + BRK)

**Strategy**: Combine perfect LDA/STA copy of the critical 7-byte genome with
BRK noisy copy for full-cell replication. The LDA/STA copy ensures the core
code survives even if the BRK copy introduces noise.

```asm
; Dual-Copy Nano: LDA/STA copy of critical bytes + BRK full copy
; Lives at $00. Copies just 7 bytes ($00-$06) to forward neighbor,
; then BRK copies the full cell.
@start:
LDY #$06            ; copy 7 bytes (Y=$06 down to $00)
@lp:
LDA $01,Y           ; read own code (offset by 1 to avoid ZP,Y issue)
STA $0401,Y         ; write to cell 1 page 0 (always forward)
DEY
BPL @lp
BRK
.byte $F5           ; noisy copy to cell 1 (overwrites with noise,
                    ; but we already wrote perfect bytes above)
CLC
BCC @start
```

Wait, this doesn't work. The BRK noisy copy overwrites the entire cell,
including the perfect bytes we just wrote. The order is wrong. We need to:
1. BRK copy first (noisy)
2. Then LDA/STA patch the critical bytes (perfect)

But BRK ends the scheduling. So we can't do LDA/STA after BRK in the same
scheduling.

Alternative: do the LDA/STA perfect copy every scheduling. The BRK copy
happens when garbage cells randomly hit BRK $F5 (if our code is in them).
Actually, the LDA/STA copy on its own IS the replication mechanism. We don't
need BRK copy at all.

But the LDA/STA copy writes to a fixed cell (cell 1 forward), not the origin.
And it requires the copy loop to complete before the timer fires.

Let me reconsider. What we really want is: copy our small genome via LDA/STA
(perfect), then also set the target's $F9:$FA to point to our code start.

```asm
; Dual-Copy Nano: perfect LDA/STA copy of minimal genome
; Copy $00-$0E (15 bytes: code + PC/P setup) to cell 1
; Set target's $F9=$00, $FA=$00 (PC points to $0000)
; Set target's $FB=$04 (P with I flag set)
@start:
SEI                 ; protect against timer interrupt
LDY #$0A            ; copy 11 bytes (Y=$0A...$00)
@lp:
LDA $01,Y           ; read own code
STA $0401,Y         ; write to cell 1
DEY
BPL @lp
; Set target's PC to $0000
LDA #$00            ; $00 -- PROBLEM: LDA #$00 is $A9 $00
```

The $00 problem again. `LDA #$00` assembles to `A9 00`, creating a zero byte.
If the CPU executes past the intended code and hits this $00, it's treated as
BRK. This is risky but manageable if the PC never reaches there during normal
execution.

Actually, the $00 is an operand, not at an opcode position. The CPU would only
hit it if PC lands exactly on that byte. During normal execution, the CPU
correctly parses `A9 00` as LDA immediate. The risk is if a mutation shifts
the PC or corrupts an instruction length, causing the CPU to land on the $00.

But we have a bigger problem: we can't use `STA $04F9` to write to cell 1's
$F9 because `$04F9` is within cell 1's memory. Let me check: cell 1 starts
at $0400 and is 1024 bytes ($0400-$07FF). So $04F9 is cell 1's offset $F9.
That works! And $04FA is offset $FA, $04FB is offset $FB.

```asm
; Dual-Copy Nano v2: perfect LDA/STA replicator with SEI
@start:
SEI                 ; protect writes from timer interrupt
LDY #$0D            ; copy 14 bytes (code $00-$0D)
@lp:
LDA $0001,Y         ; read own code (absolute,Y to avoid ZP issue)
STA $0401,Y         ; write to cell 1 page 0
DEY
BPL @lp
; Set target PC and P (so child starts at $0000 with I flag set)
; Can't use LDA #$00 (contains $00 byte), use alternative
LDA $FC             ; load RNG (doesn't matter what)
AND #$F0            ; mask off low bits, keep high
EOR $FC             ; XOR with RNG -- this doesn't reliably give $00
```

This is getting complicated. Let me use a different approach: put our code
at an address where the PC high byte is non-zero.

Actually, the simplest approach: the existing mini-spreader puts code at
$E0 and copies $E0-$FA. The PC save area ($F9:$FA) is part of the copy range.
After copying, the target's $F9:$FA point to $00E0, which is the code start.
This avoids needing to write $00 bytes explicitly.

Let me go back to the mini-spreader approach but with a twist.

---

## Design 7 (revised): Immune Nano

**Strategy**: A minimal program that does NOTHING except BRK to replicate.
Lives at $00 and consists of only BRK $F5. The insight: a program that does
nothing except replicate has zero chance of damaging itself or others through
code execution. The only writes it makes are the BRK noisy-copy.

```asm
; Immune Nano: do nothing but replicate
; Just BRK $F5 in an infinite loop
@start:
BRK
.byte $F5
BNE @start
BEQ @start
```

**Assembled**: `00 F5 D0 FC F0 FA` (6 bytes)

**Analysis**:
- Code size: 6 bytes (48 bits)
- This is essentially the brk-spreader but without the direction randomization.
  It always copies to cell 1 (forward). The BNE/BEQ loop is the standard
  unconditional branch pair.
- It makes ZERO writes to memory during execution (no LDA/STA to patch
  anything). The only memory change comes from the BRK noisy-copy itself.
- This means during its scheduling, if the timer fires before the BRK,
  NOTHING has been written, so nothing needs undoing. If BRK fires, only
  the noisy copy happens. No collateral damage.
- Compared to the brk-spreader (15 bytes), this is 60% smaller because it
  skips the direction-randomization self-modifying code. The tradeoff is
  covering only 1 direction per scheduling (but orientation randomizes this).
- Error probability per copy: 1 - (2047/2048)^48 = 2.32%

This is almost identical to the Nano Replicator (Design 1) but with BNE/BEQ
instead of CLC/BCC. The CLC/BCC version is 1 byte smaller (5 vs 6 bytes).

Let me drop this as a separate design and note that the nano replicator IS
the immune nano.

---

## Design 7 (final): Error-Correcting Replicator

**Strategy**: Store the genome redundantly and verify/repair before copying.
Keep two copies of the critical code and compare them byte-by-byte. If they
differ, use majority voting (with a third copy) or just pick one.

**Problem**: Error correction requires code to implement, which enlarges the
genome, increasing error vulnerability. This is the error-correction paradox.

The minimum viable error-correcting genome would need:
1. Code to compare two copies: LDA copy1,Y / CMP copy2,Y / BEQ @ok / ...
2. Code to repair: STA copy1,Y or STA copy2,Y
3. Code to replicate: BRK $F5

Even a trivial implementation is ~30+ bytes, which gives worse fidelity than
the 5-byte nano replicator. Error correction only pays off if the genome is
large enough that the correction code's overhead is proportionally small.

At epsilon=1/2048, the break-even point is approximately where the error
correction reduces the effective error rate enough to compensate for the
larger genome. For a triple-modular-redundancy scheme with 3 copies of N
bytes, the genome is ~3N + 20 bytes of correction code. The effective error
rate per bit of the CORRECTED payload is approximately epsilon^2 (two
independent errors needed in the same position). But the total genome exposed
to errors is 3N + 20 bytes.

For N=5 (the nano replicator): 3*5 + 20 = 35 bytes. Error probability:
1 - (2047/2048)^(35*8) = 12.7%. The corrected payload has near-zero errors
but the correction code itself (20 bytes) is uncorrected and has ~7.5% error
probability per copy. Net: WORSE than the uncorrected 5-byte nano (1.9%).

**Conclusion**: Error correction is not viable at this genome scale. It only
becomes useful for genomes >100 bytes, which are already well past the Eigen
error threshold at epsilon=1/2048.

**Interest/promise**: 1/5 (theoretically interesting but not viable)

---

## Design 8: Quiescent Neighbor

**Strategy**: Before copying to a neighbor, first write SEI ($78) to the
neighbor's code entry point. This makes the neighbor "quiescent" -- any
writes it makes during its next scheduling will be reverted on timer interrupt.
Then do the full BRK copy on the NEXT scheduling.

**Problem analysis**: Writing SEI ($78) to the neighbor is just one STA
instruction. But the neighbor might execute before we copy to it, and the
SEI at offset $00 just means it starts with I set. The neighbor then
executes the rest of its (garbage) code with I set. If it hits BRK, the
writes commit. If the timer fires first, writes are reverted. So writing
SEI to the neighbor is only ~50% effective as protection (depending on
whether BRK or timer fires first in the neighbor).

But here is a subtler point: what writes are we protecting against? The
danger is that the neighbor writes into OUR cell during its scheduling.
But the neighbor's writes go to ITS neighborhood, which may or may not
include us (depends on the random origin assignment). Even if the neighbor
IS scheduled, its writes target its own randomly-assigned neighborhood,
which is centered on a random cell -- not necessarily adjacent to us.

Wait, I'm confusing the model. Each scheduling picks a random cell as the
origin. That cell's code runs, and it can write to its 7x7 neighborhood.
The "neighbor" relationship is between the origin cell and its neighborhood,
not between physical cells and their physical neighbors.

So writing SEI to a physical neighbor's cell doesn't help protect us from
random cells' writes. The random cell could be anywhere on the board, and
its neighborhood mapping is randomized.

**Revised strategy**: The quiescent approach doesn't work as I initially
conceived. The protection from cross-contamination would require making ALL
cells on the board quiescent, which is impractical.

However, there IS a useful variant: write SEI + a jump-to-self loop into
the neighbor BEFORE copying our code there. This ensures the neighbor is
executing harmless code (just SEI + loop) rather than random garbage. If
the neighbor gets scheduled before our copy completes, it just loops doing
nothing. Then we copy our replicator code over the loop.

But BRK copy overwrites the entire cell atomically, so there's no race.
And LDA/STA copy needs multiple schedulings, during which the target could
be scheduled and overwrite our partial copy.

Let me implement the SEI-loop-then-copy approach with SEI protection:

```asm
; Quiescent Neighbor: write SEI+loop to target, then copy self
; Phase 1 (odd schedulings): write SEI loop to target
; Phase 2 (even schedulings): BRK copy self to target
; Toggle phase with a flag byte at $20 (outside critical code)
;
; But wait: the BRK copy in phase 2 overwrites EVERYTHING including
; the SEI loop we wrote in phase 1. So phase 1 is pointless -- the
; BRK copy replaces all of it.
;
; This strategy only makes sense with LDA/STA copy, where we control
; exactly which bytes we write.
```

Actually, this doesn't work well for BRK-based copiers. Let me instead
design it for LDA/STA copy:

```asm
; Quiescent Target: two-phase LDA/STA replicator
; Phase 0: write SEI ($78) + BRK $00 ($00 $00) to target offset $E0
;          This makes the target harmless when scheduled.
; Phase 1: LDA/STA copy of own code ($E0-$FA) to target.
;          Overwrites the SEI+BRK with actual replicator code.
; Uses a phase counter at $D0 (toggled each scheduling).
.org $00D0
; Phase counter at $D0 (initialized to $00)
.byte $00
.org $00E0
@start:
SEI                 ; protect our writes from timer interrupt
LDA $FC             ; RNG
AND #$03
CLC
ADC #$01
ASL
ASL                 ; target page 0 high byte
STA @st+2           ; patch STA high byte
; Check phase
LDA $D0
EOR #$01            ; toggle phase
STA $D0
BNE @phase1         ; if was $00, now $01: do phase 1 (full copy)
; Phase 0: write SEI to target's entry point
LDA #$78            ; SEI opcode
@st:
STA $04E0           ; target offset $E0 (high byte patched above)
BRK
.byte $01
BMI @start
@phase1:
; Phase 1: full copy of $E0-$FA
LDY #$1A
@lp:
LDA $E0,Y
STA $04E0,Y         ; high byte NOT patched here -- PROBLEM
DEY
BPL @lp
BRK
.byte $01
BMI @start
```

This is getting complicated and has a bug (the STA high byte in @phase1 isn't
patched). Also the code is now ~35+ bytes, too large. Let me abandon this
approach.

**Interest/promise**: 2/5 (interesting idea but implementation is complex
and the benefits are marginal)

---

## Design 9: Fork-Aware Replicator

**Strategy**: After a BRK copy, both parent and child resume execution.
The child detects it's a fresh copy by checking a sentinel byte. The parent
writes a sentinel before BRK, so the child sees it and runs initialization
code. The parent clears the sentinel after BRK, so on its next scheduling it
skips initialization.

**Insight**: When BRK noisy-copy fires, the origin cell continues at PC+2.
The destination cell gets a copy of the origin (with noise) and will resume
from whatever PC is in its $F9:$FA (which is the same as the parent's, since
the copy included those bytes). So both parent and child resume at the same
instruction.

If the parent writes a sentinel byte BEFORE BRK, the copy includes the
sentinel. The child sees the sentinel and knows it's new. The parent clears
the sentinel AFTER BRK. On the child's first scheduling, it sees the sentinel
and can run initialization code (e.g., setting up a different phase).

```asm
; Fork-Aware Replicator
; $20 = sentinel byte. Parent sets it to $FF before BRK copy,
; clears it after. Child sees $FF and runs init code.
@start:
; Set sentinel
LDA #$FF
STA $20
; BRK copy
BRK
.byte $F5           ; noisy copy forward
; Parent continues here. Clear sentinel.
LDA #$01            ; non-zero, non-$FF value
STA $20
; Do a second copy (parent is the "mature" replicator)
BRK
.byte $F5           ; copy forward again
; Loop
CLC
BCC @start

; Child entry: when scheduled, it enters at @start.
; It reads $20 and sees $FF (from the copy).
; But wait -- the child enters at the SAME PC as the parent,
; which is the instruction AFTER the first BRK. So the child
; starts at the "LDA #$01 / STA $20" -- it clears its own
; sentinel immediately. It never gets to run special init code!
```

The problem: the child resumes at the same PC as the parent (post-BRK).
There's no way for the child to know it's a child vs the parent at the
point of resumption, because they share the same code and state (modulo noise).

The only difference is their POSITION on the board. The child is in a
different cell. But there's no way to read your own cell coordinates.

**Alternative**: Use the RNG bytes ($FC-$FF) as a source of asymmetry.
After BRK, the parent is rescheduled with fresh RNG. The child, when
eventually scheduled, also gets fresh RNG. But they get DIFFERENT random
values. This doesn't help for fork detection.

**Alternative 2**: Use a counter byte. Before BRK copy, increment a counter.
The copy includes the incremented counter. The parent continues past BRK
and can decrement it. The child, when scheduled, sees the incremented
counter. But again, the child resumes at the same PC (post-BRK), so it also
decrements the counter. No asymmetry.

**Conclusion**: True fork detection is impossible in this architecture because
the child is a perfect (noisy) copy of the parent at the moment of BRK, and
both resume at the same PC. There's no syscall to read your cell ID. The only
source of asymmetry is copy noise itself, which is unreliable.

**Interest/promise**: 1/5 (impossible to implement reliably)

---

## Design 10: Cooperative Pair

**Strategy**: Two complementary programs A and B. A copies B to neighbors,
and B copies A to neighbors. If one gets corrupted, the other can restore it.

**Problem**: Each program needs to know the other's code to copy it. This
doubles the genome size. Also, BRK noisy-copy copies the ENTIRE origin cell,
so A can't selectively copy B's code -- it copies itself.

For LDA/STA copy: A reads B's code from a neighbor cell and writes it to
another neighbor. But A needs to know which neighbor has B. With random
orientation, cell indices change meaning each scheduling.

**Alternative**: A and B are interleaved within the same cell. Code A lives
at $00-$7F, Code B lives at $80-$DF. A copies B's code to a neighbor's
$80-$DF region, and B copies A's code to a neighbor's $00-$7F region.
Both use LDA/STA for perfect fidelity. They alternate execution using the
saved PC.

But this requires each half to be a complete replicator, and the combined
genome is >50 bytes. Not viable at epsilon=1/2048.

**Interest/promise**: 1/5 (not viable at this genome scale)

---

## Rankings and Recommendations

### Ranked by promise (most to least)

| Rank | Design | Size | Error/copy | Key advantage | Score |
|:---:|:---|:---:|:---:|:---|:---:|
| 1 | Nano 2x | 7 bytes | 2.70% | 2-direction coverage, tiny genome | 5/5 |
| 2 | Nano 1x | 5 bytes | 1.94% | Absolute minimum genome | 4/5 |
| 3 | Walking Nano | 7 bytes | 2.70% | Mobility + replication | 4/5 |
| 4 | Nano 4x | 11 bytes | 4.21% | All-direction coverage | 3/5 |
| 5 | SEI Shield | 26 bytes | N/A (LDA/STA) | Perfect copy fidelity | 3/5 |
| 6 | SEI Fortress 2x | 26 bytes | 9.68% | Atomic setup | 2/5 |
| 7 | Quiescent Target | ~35 bytes | N/A | Target protection | 2/5 |
| 8 | Error-Correcting | ~35+ bytes | ~12.7% | Error correction | 1/5 |
| 9 | Fork-Aware | N/A | N/A | Impossible to implement | 1/5 |
| 10 | Cooperative Pair | >50 bytes | >20% | Mutual repair | 1/5 |

### Recommended experimental order

**Test first**: Nano 2x and Nano 1x. These are the simplest and have the
best theoretical fidelity. Run the same viability experiment from the
experiment log (8x8 board, seed 42, 2M interrupts, census at 250k/500k/1M/2M).

**Test second**: Walking Nano. Compare survival with vs without mobility.
Also compare against the existing directional-spreader (which is 10 bytes,
larger genome than our 7-byte Walking Nano).

**Test third**: Nano 4x. Test whether guaranteed 4-direction coverage helps
initial colonization compared to the random-orientation 1x and 2x variants.

**Skip**: Error-correcting, fork-aware, and cooperative designs are not
viable at this genome scale. They would only become interesting if the
noise rate were dramatically reduced (e.g., epsilon < 1/100000).

### Key theoretical insight

The optimal replicator at epsilon=1/2048 is the **smallest possible self-
replicating program**. Every additional byte of genome increases vulnerability
to copy noise. The Eigen error threshold at this mutation rate is approximately:

    L_max = ln(s) / epsilon ≈ ln(s) / (1/2048) ≈ 2048 * ln(s)

where s is the selective advantage (replication rate / destruction rate).
For s ≈ 2 (doubling advantage): L_max ≈ 2048 * 0.693 ≈ 1419 bits ≈ 177 bytes.

So genomes under ~177 bytes should be below the error threshold in principle.
But this assumes copy noise is the ONLY source of error. In practice,
cross-contamination adds a large constant error rate independent of genome
size, which dramatically lowers the effective threshold.

The real battle is not against copy noise but against cross-contamination.
The best defense is rapid replication to maintain population majority.
Once replicators occupy >50% of cells, cross-contamination becomes self-
reinforcing (replicators contaminate each other with replicator code, which
is harmless or even beneficial).

### Assembly source files

The following designs are ready for experimental testing:

#### nano-1x.asm
```asm
; Nano Replicator 1x: minimal 5-byte BRK spreader
; Copies forward (cell 1). Orientation randomizes direction.
@start:
BRK
.byte $F5
CLC
BCC @start
```

#### nano-2x.asm
```asm
; Nano Replicator 2x: 7-byte BRK spreader, two directions
; Copies to cell 1 (forward) and cell 2 (right).
@start:
BRK
.byte $F5
BRK
.byte $F6
CLC
BCC @start
```

#### walking-nano.asm
```asm
; Walking Nano: copy forward then move forward
; 7 bytes. Leaves copies behind as it moves.
@start:
BRK
.byte $F5
BRK
.byte $01
CLC
BCC @start
```

#### nano-4x.asm
```asm
; Nano Replicator 4x: 11-byte BRK spreader, all 4 directions
@start:
BRK
.byte $F5
BRK
.byte $F6
BRK
.byte $F7
BRK
.byte $F8
CLC
BCC @start
```

#### sei-shield.asm
```asm
; SEI Shield: atomic LDA/STA copy (identical to mini-spreader-sei)
.org $00E0
@start:
SEI
LDA $FC
AND #$03
CLC
ADC #$01
ASL
ASL
STA @st+2
LDY #$1A
@lp:
LDA $E0,Y
@st:
STA $04E0,Y
DEY
BPL @lp
BRK
.byte $01
BMI @start
```
