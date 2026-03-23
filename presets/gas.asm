; Gas: random walk particle
; Swaps with a random cardinal neighbor each scheduling.
; On a board full of these, you get Brownian motion — cells
; constantly shuffling, creating a "gas" visual effect.
; Color: writes to RGB bitmap to appear as a colored dot.
; Uses RNG to pick direction.
@start:
LDA $FC
AND #$03
CLC
ADC #$01          ; 1-4: N/E/S/W
STA @brk+1        ; patch BRK operand
; Write red pixel to bitmap
LDA #$FF
STA $0380          ; red channel byte 0
@brk:
BRK
.byte $01          ; swap with cell 1 (patched to 1-4)
BNE @start
BEQ @start