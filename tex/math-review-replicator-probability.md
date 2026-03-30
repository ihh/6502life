# Mathematical Review: replicator-probability.tex
# Date: 2026-03-28

## Summary

The document computes the probability of a random 1024-byte 6502 program
constituting a self-replicating byte-level copier. It analyzes byte-by-byte
constraints, derives NOP insertion corrections via generating functions, and
estimates threshold board sizes for spontaneous emergence.

The core mathematical framework (base probability, byte-constraint counting,
generating function for NOP insertions) is sound. However, I found one
significant error (BRK operand byte not counted), one table with systematically
wrong units (memory requirements), an incorrect decay-rate claim in a remark,
and an inconsistency in the abstract. The generating function derivation is
correct.

---

## Errors

### ERROR 1: BRK operand byte not counted under random initialization (Lines 496--521, 589--616)

**Location:** Section 4.6 (BRK variant) and Section 5.3 (BRK variant table).

**Problem:** The BRK instruction on the 6502 reads one operand byte following
the opcode. In the 6502life VM, `BRK` with operand `$00` resets PC to 0 and
yields (the desired behavior). `BRK` with any nonzero operand sets PC to
`brkPC + 2` (past the instruction) and dispatches to the BRK operation table:
operands 1--48 trigger swap (destructive), operands 49--96 trigger copy (a
different mechanism), operands 97--255 either trigger disabled operations or
yield at the wrong PC.

For the LDA/STA loop replicator to function, BRK must reset PC to 0, which
requires operand = `$00`. In random initialization, byte 7 is uniformly
random, so the probability that it equals `$00` is 1/256 (8 additional bits
of constraint).

The document's 7-byte BRK variant (bytes 0--6) implicitly assumes the BRK
operand is free, but this is only true under zero initialization. Under random
initialization, 8 bytes are constrained (bytes 0--6 as listed, plus byte 7
= `$00`).

**Consequence:** The BRK variant under random initialization should have:
- $B_{\text{eff}} = 49.415 + 8 = 57.415$ bits (same as the BNE branch variant!)

Actually, let me re-derive more carefully. The 7-byte table counts bytes 0--6,
with byte 6 = `$00` (BRK opcode). The BRK operand is byte 7, which must also
be `$00`. So the constrained bytes are B5 00 9D 00 04 E8 00 00 (8 bytes).
The probability is:

$$P = \frac{1 \cdot 1 \cdot 1 \cdot 1 \cdot 48 \cdot 2 \cdot 1 \cdot 1}{256^8} = \frac{96}{2^{64}} = \frac{3}{2^{59}} \approx 2^{-57.415}$$

This equals the conservative BNE branch variant. The BRK variant no longer
dominates under random initialization.

Under zero initialization, both byte 6 and byte 7 are free, so the 6-byte
count (bytes 0--5) remains correct: $B_{\text{eff}} \approx 41.4$ bits.

**Correction:** The BRK variant table (Section 5.3) should list byte 7 as
constrained (BRK operand = `$00`, 8 bits) for random initialization. The
total becomes 57.415 bits. Under zero initialization, the "6 constrained
bytes" analysis is correct.

The combined probability (Section 5.4) and the union in Equation (3) must be
revised. The BRK term becomes $96/2^{64}$ (not $96/2^{56}$), and it no longer
dominates -- the branch variant with BNE is comparable.

**Downstream impact:** This error propagates to:
- Section 7 (Effective Information Content): the BRK random-init result changes
  from 48.8 to 56.8 bits (with NOPs).
- Theorem 1: the boxed result of 48.8 bits is wrong; should be ~55 bits
  (the branch and BRK variants are comparable, with the union giving ~54--55 bits).
- Section 8 (Primordial Soup): all BRK random-init entries in the tables are wrong.
- The conclusion table is wrong for the BRK random-init row.

Under zero initialization, the results are unaffected (BRK operand is free).

### ERROR 2: Memory requirements table has systematically wrong units (Lines 1114--1125)

**Location:** Section 8.3 (Memory requirements table).

**Problem:** The document correctly states "A board of side $B$ requires
$B^2 \times 1024$ bytes = $B^2$ KiB." However, the memory table computes
$B^2$ bytes instead of $B^2 \times 1024$ bytes, making every entry 1024x
too small.

Verification (using the document's own board side values):

| Scenario | Board side B | Doc claims | Correct value |
|----------|-------------|------------|---------------|
| BRK, zero init | $1.4 \times 10^6$ | ~1.8 TiB | ~1.8 PiB (= 1825 TiB) |
| BRK, random init | $2.2 \times 10^7$ | ~450 TiB | ~440 PiB (= 450,760 TiB) |
| Branch, random init | $2.0 \times 10^8$ | ~37 PiB | ~36 EiB (= 37.3M TiB) |
| JMP, random init | $5.5 \times 10^9$ | ~28 EiB | ~27,000 EiB (~26 ZiB) |

Each entry is off by a factor of $2^{10}$ (= 1024). The numerical prefixes
(1.8, 450, 37, 28) are approximately correct, but the units are each one step
too small in the binary prefix hierarchy.

**Correction:** Replace the memory column with the correct values shown above.
Note: with Error 1 corrected, the BRK random-init board side also changes,
so those rows would need recomputation.

### ERROR 3: Abstract claims ~43 bits, inconsistent with all computed results (Lines 34--44)

**Location:** Abstract.

**Problem:** The abstract states "These relaxations reduce the effective
information content to approximately 43 bits." None of the computed $B_{\text{eff}}$
values in the paper equal 43 bits:

- BRK, zero init, with NOPs: ~40.8 bits
- BRK, random init, with NOPs: ~48.8 bits (or ~56.8 with Error 1 corrected)
- Branch, random init, with NOPs: ~55.2 bits
- JMP, random init, with NOPs: ~64.8 bits

The value 43 does not appear anywhere in the analysis. It may have been an
early estimate that was not updated.

**Correction:** Change "approximately 43 bits" to match the actual results.
With Error 1 corrected, the most favorable case is the BRK variant under zero
initialization at ~40.8 bits. The abstract should specify which scenario it
refers to: "approximately 41 bits under zero initialization, or approximately
55 bits under random initialization."

---

## Warnings

### WARNING 1: Undocumented NOP opcode counts ($n_1, n_2, n_3$) are unverified against Sfotty

The document lists 7 single-byte NOPs, 13 two-byte NOPs, and 7 three-byte NOPs
based on standard NMOS 6502 undocumented opcode knowledge. However, the Sfotty
emulator used in 6502life may implement a different subset of undocumented
opcodes. Some opcodes listed as NOPs might be handled differently (e.g., as
JAM/halt instructions). The document acknowledges this in Section 9.1 but does
not verify against the actual emulator.

The NOP correction factor is small regardless ($\Delta B \approx 0.6$ bits),
so this uncertainty has limited impact on the final result.

### WARNING 2: Some 2-byte "NOP" opcodes may modify processor flags (Lines 768--779)

Opcodes `$80`, `$82`, `$C2`, `$E2` (immediate-mode undocumented NOPs) are
sometimes documented as affecting the N and Z flags on NMOS 6502 variants
(they effectively load-and-discard the immediate value). If these opcodes
modify flags, they are NOT safe at insertion point $j_3$ (between increment
and branch) in the branch variant, because they would corrupt the Z flag
that `BNE` depends on.

This affects only the branch variant and only at one of four insertion points.
For the BRK and JMP variants, flag modification is harmless. The impact is
small: at worst, the branch variant should use $K = 3$ NOP insertion points
(instead of 4) with a reduced $n_2$ count, which barely changes the NOP
correction factor.

### WARNING 3: BRK-copy replicator not analyzed

A much simpler replicator exists: `BRK` (opcode `$00`) with operand in [49, 96]
triggers the VM's built-in copy operation, copying the entire cell to a neighbor
with noise. This is a 2-byte "replicator" (1 constrained opcode + 48/256
probability for the operand = $48/256^2 = 3/4096$ per cell). On a standard
$256^2$ board with random initialization, the expected number of cells whose
first two bytes form a BRK-copy is $65536 \times 48/65536 = 48$.

This mechanism is qualitatively different (it uses a VM primitive rather than
a programmatic copy loop, and the copies are noisy with probability $p_{\text{bitNoise}}$
per bit), but it is relevant to the "primordial soup" question. It dramatically
lowers the effective $B_{\text{eff}}$ for a certain definition of "replicator."

### WARNING 4: The generating function sum $Q(1)^K$ double-counts some patterns

The total probability computation (Equation 7) sums $Q(1)^K$ independently for
each insertion point. This assumes NOP insertions at different points are
independent, which is correct given that the random bytes at different positions
are independent. However, the sum includes NOP-padded programs that exceed the
1024-byte cell boundary. The truncation remark (lines 937--944) correctly notes
this is negligible, though the stated decay rate is wrong (see Warning 5 below).
The mathematical framework is sound; this is a minor modeling note.

### WARNING 5: Incorrect decay rate in truncation remark (Lines 937--944)

The remark claims "$q(\ell)$ decays exponentially as $(27/256)^\ell \approx
0.1055^\ell$." This is incorrect. The characteristic polynomial of the
recurrence $q(\ell) = (7/256)q(\ell-1) + (13/256)q(\ell-2) + (7/256)q(\ell-3)$
has dominant root $\approx 0.368$, not $27/256 \approx 0.1055$. The actual
tail beyond $\ell = 10$ is approximately $1.1 \times 10^{-5}$ (not the claimed
$1.5 \times 10^{-10}$). This is still negligible relative to $Q(1) \approx 1.118$,
so the conclusion holds, but the stated bound is wrong by 5 orders of magnitude.

Note: the value $27/256$ is the sum of NOP probabilities per byte $(n_1 + n_2 + n_3)/256$,
which would be the geometric decay rate only if all NOPs were 1-byte. The
multi-byte NOPs create a recurrence with a larger dominant root because a
multi-byte NOP "uses up" multiple bytes (contributing the same probability as
a 1-byte NOP but consuming more positions).

---

## Style Suggestions

### STYLE 1: Exploratory prose in a formal section (Lines 780--850)

Lines 780--850 contain informal exploratory prose ("Wait ---", "Actually, we
must be more careful", "Let me restart with a cleaner framework") that reads
like working notes rather than a finished analysis. The final clean derivation
(Definition at line 851 and the recurrence at line 879) is correct and
self-contained. The exploratory material could be removed or moved to an
appendix.

### STYLE 2: Notation for correction factor $A(j_0)$

The correction factor in Equation (4) is written as $A(j_0)$ but actually
depends on all four NOP counts $(j_0, j_1, j_2, j_3)$ through the total
length $L = N_0 + j_0 + j_1 + j_2 + j_3$. It should be notated as
$A(j_0, j_1, j_2, j_3)$ or $A(J)$ or $A(L)$. Since the document immediately
shows $A = 1$ in all cases, this is inconsequential to the math.

### STYLE 3: "Wait" in typeset text (Line 781)

The text "Wait ---" appears in the typeset document (line 781). This should
be removed from the published version.

### STYLE 4: Branch variant BPL/BMI exclusion rationale could be more explicit

The document excludes BPL and BMI because they "fail on half the iterations."
The reasoning is correct but would benefit from being more explicit. BPL with
INX from X=0 copies bytes 0--127 (128 bytes), then falls through when X=128
(N flag set). This is only a partial page copy: bytes 128--255 are never
written. Under Definition 1, which requires a "complete copy of its own page 0,"
BPL is correctly excluded. However, the document could note that BPL does
successfully copy the replicator's code bytes (0--8), and would qualify under
a weaker "functional replicator" definition that only requires the child's
code to match. This weaker definition might be relevant for the primordial
soup discussion (Section 8).

BMI is more clearly excluded: with INX from X=0, it falls through on the first
iteration (N=0 after X becomes 1). With INX from X=128, it copies bytes
128--255 but never copies the replicator code at bytes 0--8. With DEX, similar
analysis applies. BMI never copies the code bytes under any starting X value
with INX.
