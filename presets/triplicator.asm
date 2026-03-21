; Triplicator: self-repairing replicator with triple modular redundancy
; 3 backup copies at $0101+Y, $0201+Y, $0301+Y.
; All encoded addresses have nonzero bytes — no parasitic BRK traps.
; Page 0 writes use (indirect),Y via pointer at $42:$43.
; Repairs ONE byte per scheduling via majority vote, then BRK copies.
; majority(a,b,c) = (a&b)|(b&c)|(a&c).
; Repair index at $40, temp at $41, page0 pointer at $42:$43 = $0001.
; Repair range: code bytes $01-$3F (63 bytes). Byte $00 is NOT repaired
; but it's just DEC $40 ($C6) which is self-evident.
@start:
DEC $40
BPL @go
LDA #$3E           ; wrap: repair range $01-$3F
STA $40
@go:
LDY $40
; majority vote across 3 backup copies
LDA $0101,Y
AND $0201,Y
STA $41            ; (a&b)
LDA $0201,Y
AND $0301,Y
ORA $41            ; (a&b)|(b&c)
STA $41
LDA $0101,Y
AND $0301,Y
ORA $41            ; majority
; write to all 3 backups
STA $0101,Y
STA $0201,Y
STA $0301,Y
; write to page 0 via (indirect),Y: ($42),Y where $42:$43 = $0001
STA ($42),Y
; copy to forward neighbor
BRK
.byte $F5
BNE @start
BEQ @start