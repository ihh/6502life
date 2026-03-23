; Blue: rock-paper-scissors ecology (BLUE team)
; Type tag at $A5 = 3 (blue)
LDA #$03
STA $A5
LDA #$62           ; 'b'
STA $03E0
LDA #$6C           ; 'l'
STA $03E1
LDA #$75           ; 'u'
STA $03E2
; Blue bitmap
LDA #$FF
STA $03C0
STA $03C1
@start:
BRK
.byte $F5
BNE @start
BEQ @start