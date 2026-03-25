; Green: rock-paper-scissors ecology (GREEN team)
; Hue byte at $3FF: 85 = green (hue ≈ 120°)
LDA #$55
STA $03FF
@start:
BRK
.byte $31
BNE @start
BEQ @start