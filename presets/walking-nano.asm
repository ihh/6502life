; Walking Nano: copy forward then move forward (7 bytes)
; Leaves copies behind as it walks across the board.
; Copy+move pattern means the original persists at the old location.
@start:
BRK
.byte $F5       ; copy to cell 1 (forward)
BRK
.byte $01       ; swap with cell 1 (move forward)
CLC
BCC @start