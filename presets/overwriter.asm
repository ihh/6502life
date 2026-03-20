; Overwriter: Writes a pattern to all 4 cardinal neighbor cells
; Write NOP sled to cardinal neighbors (N=1, E=2, S=3, W=4)
; Each cell is at cellIndex * $0400
; N=$0400, E=$0800, S=$0C00, W=$1000
; Write EA (NOP) to first 240 bytes of each
LDX #$01
@outer:
LDY #$EF
LDA #$EA
@inner:
; Compute target page = X * 4
; Store NOP at target + Y offset
STA $0401,Y
DEY
BNE @inner
STA $0401,Y
INX
CPX #$05
BNE @outer
BRK
.byte $01
