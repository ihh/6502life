; Blue: rock-paper-scissors ecology (BLUE team)
; Hue byte at $3FF: 170 = blue (hue ≈ 240°)
LDA #$AA
STA $03FF
@start:
BRK
.byte $31
BNE @start
BEQ @start