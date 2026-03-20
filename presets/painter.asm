; Painter: Fills the RGB bitmap area (0x380-0x3BF) with a pattern
; Painter: create a pattern in the 16x16 RGB bitmap
; R channel at $380 (32 bytes), G at $3A0, B at $3C0
LDX #$1F
LDA #$FF
@fill_r:
STA $0380,X
DEX
BPL @fill_r
; Green: alternating
LDX #$1F
@fill_g:
TXA
STA $03A0,X
DEX
BPL @fill_g
; Blue: inverse
LDX #$1F
@fill_b:
TXA
EOR #$FF
STA $03C0,X
DEX
BPL @fill_b
; Set name to "painter"
LDA #$70   ; 'p'
STA $03E1
LDA #$61   ; 'a'
STA $03E2
LDA #$69   ; 'i'
STA $03E3
LDA #$6E   ; 'n'
STA $03E4
LDA #$74   ; 't'
STA $03E5
; Yield
BRK
.byte $01
