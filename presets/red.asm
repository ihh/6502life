; Red: rock-paper-scissors ecology (RED team)
; Hue byte at $3A0: 1 = red (hue ≈ 0°)
LDA #$01
STA $03A0
@start:
BRK
.byte $F5
BNE @start
BEQ @start