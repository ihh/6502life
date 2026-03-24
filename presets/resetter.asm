; Resetter: Drives board toward Dead state (byte[0:1] = 00,00)
; BRK-first: copy self to cell 1, then zero cell 2's entry + PC.
; Writing $F9:$FA (PC save area) is critical: without it, the target
; cell continues executing random code which overwrites the zeros.
; With PC=0 + byte[0:1]=00, the target enters BRK 0 dead loop.
; ~21 cycles for the STA phase, fits in 96%+ of time slices.
; 22 bytes. The resetter itself is B-state (byte[0]=00).
@start:
BRK
.byte $31          ; noisy copy to cell 1 (forward), yield
LDA #$00           ; A = 0
STA $0800          ; cell 2 byte[0] = 0 (BRK opcode)
STA $0801          ; cell 2 byte[1] = 0 (dead operand)
STA $08F9          ; cell 2 PCHI = 0  (reset PC to $0000)
STA $08FA          ; cell 2 PCLO = 0
BNE @start
BEQ @start
