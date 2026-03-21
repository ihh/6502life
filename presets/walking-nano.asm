; Walking Nano: copy forward then move forward (8 bytes)
; Leaves copies behind as it walks across the board.
@start:
BRK
.byte $F5       ; copy to cell 1 (forward)
BRK
.byte $01       ; swap with cell 1 (move forward)
BNE @start
BEQ @start