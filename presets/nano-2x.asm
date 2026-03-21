; Nano 2x: 7-byte BRK spreader, two directions
; Copies to cell 1 (forward) and cell 2 (right) on alternating schedulings.
; 56 bits critical code → 97.3% perfect copy rate.
@start:
BRK
.byte $F5
BRK
.byte $F6
CLC
BCC @start