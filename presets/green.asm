; Green: rock-paper-scissors ecology (GREEN team)
; Type tag at $A5 = 2 (green)
LDA #$02
STA $A5
LDA #$67           ; 'g'
STA $03E0
LDA #$72           ; 'r'
STA $03E1
LDA #$6E           ; 'n'
STA $03E2
; Green bitmap
LDA #$FF
STA $03A0
STA $03A1
@start:
BRK
.byte $F5
BNE @start
BEQ @start