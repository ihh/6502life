; Nano Replicator: minimal BRK spreader (6 bytes)
; Copies forward (cell 1). Orientation randomizes direction each scheduling.
; Uses BNE/BEQ for unconditional loop (CLC/BCC has a Sfotty bug).
@start:
BRK
.byte $31
BNE @start
BEQ @start