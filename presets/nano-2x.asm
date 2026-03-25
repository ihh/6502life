; Nano 2x: 8-byte BRK spreader, two directions
; Copies to cell 1 (forward) and cell 2 (right) on alternating schedulings.
@start:
BRK
.byte $31
BRK
.byte $32
BNE @start
BEQ @start