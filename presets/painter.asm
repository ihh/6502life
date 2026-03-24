; Painter: Fills the 16x16 monochrome bitmap (0x3C0-0x3DF) with a pattern
; and sets hue byte at 0x3FF for coloring
LDA #$AA
STA $03FF           ; hue = blue
; Fill bitmap with alternating pattern
LDX #$1F
@fill:
TXA
STA $03C0,X
DEX
BPL @fill
; Set name to "paint"
LDA #$70   ; 'p'
STA $03E0
LDA #$61   ; 'a'
STA $03E1
LDA #$69   ; 'i'
STA $03E2
LDA #$6E   ; 'n'
STA $03E3
LDA #$74   ; 't'
STA $03E4
; Yield
BRK
.byte $01
