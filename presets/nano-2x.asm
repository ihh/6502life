; Nano 2x: 8-byte BRK spreader, two directions
; Copies to cell 1 (forward) and cell 2 (right) on alternating schedulings.
@start:
BRK
.byte $F5
BRK
.byte $F6
BNE @start
BEQ @start