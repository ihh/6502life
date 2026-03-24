; Gas: random walk particle
; Swaps with a random cardinal neighbor each scheduling.
; On a board full of these, you get Brownian motion — cells
; constantly shuffling, creating a "gas" visual effect.
; Color: writes hue byte and bitmap pixel to appear as a colored dot.
; Uses RNG to pick direction.
@start:
LDA $FC
AND #$03
CLC
ADC #$01          ; 1-4: N/E/S/W
STA @brk+1        ; patch BRK operand
; Set hue and bitmap pixel
LDA #$01
STA $03FF          ; hue = red
LDA #$80
STA $03C0          ; bitmap: top-left pixel on
@brk:
BRK
.byte $01          ; swap with cell 1 (patched to 1-4)
BNE @start
BEQ @start
