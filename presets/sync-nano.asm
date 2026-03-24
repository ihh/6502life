; Sync Nano: periodic self-replicator using sync interrupts
; Requests BRK 253 (sync) with period 500 cycles, then BRK copies forward.
; On next scheduling, execution resumes at the copy BRK.
; After copy, loops back to request next sync interrupt.
@start:
LDX #$F4        ; period low byte (500 = $01F4)
LDY #$01        ; period high byte
BRK
.byte $FD       ; BRK 253 = sync interrupt request (yield)
; Execution resumes here on next scheduling:
BRK
.byte $F5       ; BRK 245 = noisy copy to cell 1 (forward)
BNE @start      ; loop back (unconditional via BNE/BEQ pair)
BEQ @start
