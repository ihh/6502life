; Nano Replicator: minimal 5-byte BRK spreader
; Copies forward (cell 1). Orientation randomizes direction each scheduling.
; At 40 bits, probability of perfect copy ≈ 98.1%.
@start:
BRK
.byte $F5
CLC
BCC @start