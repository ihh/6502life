; Blue: rock-paper-scissors ecology (BLUE team)
; Hue byte at $3A0: 170 = blue (hue ≈ 240°)
LDA #$AA
STA $03A0
@start:
BRK
.byte $F5
BNE @start
BEQ @start