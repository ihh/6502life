; Knight: Swaps with cells in an L-shaped pattern like a chess knight
; Knight: swap with cells at (2,1), (1,2), etc. - L-shaped moves
; Cell 14 = NE^2 = (2,1), Cell 13 = N^2E = (1,2)
; Operand = src*49 + dest; src=0 (origin), so operand = dest
; Alternate between these two
LDA $10     ; load move counter
AND #$01    ; alternate
BNE @move2
; Move 1: swap origin with cell 14 (operand $0E)
BRK
.byte $0E
@move2:
; Move 2: swap origin with cell 13 (operand $0D)
BRK
.byte $0D
@done:
INC $10     ; increment counter
BRK
.byte $01   ; swap origin with cell 1 (North)
