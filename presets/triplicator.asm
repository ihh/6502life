; Triplicator: self-repairing replicator
; BRK copy FIRST (byte 0), then repair one byte, then loop.
; 3 copies at pages 0, 2, 3. Majority vote repairs one byte per scheduling.
; Repair index at $40, temp at $41 (outside code range $00-$3F).
@top:
BRK
.byte $F5           ; copy to forward neighbor — fires every scheduling
; Repair one byte (parent continues here after BRK yields)
DEC $40
BPL @go
LDA #$30            ; repair range $01-$30 (49 bytes, covers code)
STA $40
@go:
LDY $40
LDA $0200,Y
AND $0300,Y
STA $41
LDA $00,Y
AND $0200,Y
ORA $41
STA $41
LDA $00,Y
AND $0300,Y
ORA $41
STA $00,Y
STA $0200,Y
STA $0300,Y
BNE @top
BEQ @top