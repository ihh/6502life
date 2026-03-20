; Tumbler: Alternates between moving forward and turning (tumble-roll)
; Tumbler: swap with North neighbor, then rotate oriented registers
; This creates movement across the board
; Step 1: swap origin with cell 1 / North (operand $01)
BRK
.byte $01
; After BRK, scheduler moves us. When we get control again:
; Modify oriented register at $F0 to rotate our "forward" direction
LDA $F0
CLC
ADC #$04   ; rotate by adding to top bits (each unit = ~5.6 degrees)
STA $F0
; Loop
BRK
.byte $01
