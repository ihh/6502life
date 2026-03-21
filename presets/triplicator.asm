; Triplicator: self-repairing replicator with triple modular redundancy
; 3 copies at pages 0, 2, 3. Repairs ONE byte per scheduling then copies.
; majority(a,b,c) = (a&b)|(b&c)|(a&c) corrects single-copy errors.
; Repair index at $3E, temp at $3F.
@top:
; Decrement repair index, wrap 0->$2F
DEC $3E
BPL @go
LDA #$2F
STA $3E
@go:
LDY $3E
; majority vote for byte Y across pages 0, 2, 3
LDA $0200,Y        ; b
AND $0300,Y        ; b&c
STA $3F
LDA $00,Y          ; a
AND $0200,Y        ; a&b
ORA $3F            ; (b&c)|(a&b)
STA $3F
LDA $00,Y          ; a
AND $0300,Y        ; a&c
ORA $3F            ; majority
; write back to all 3 copies
STA $00,Y
STA $0200,Y
STA $0300,Y
; copy to forward neighbor
BRK
.byte $F5
BNE @top
BEQ @top