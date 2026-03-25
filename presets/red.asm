; Red: rock-paper-scissors ecology (RED team)
; Hue byte at $3FF: 1 = red (hue ≈ 0°)
LDA #$01
STA $03FF
@start:
BRK
.byte $31
BNE @start
BEQ @start