; Triplicator with repair loop (N=10 bytes per scheduling)
; BRK copy FIRST, then repair N bytes in a loop, then back to top.
; 3 copies at pages 0, 2, 3. Majority vote repairs N bytes per scheduling.
; Repair index at $40, temp at $41 (outside code range).
@top:
BRK
.byte $31           ; copy to forward neighbor — fires every scheduling
; Repair N bytes in a loop
LDX #10             ; repair counter
@outer:
DEC $40
BPL @noWrap
LDA #$37            ; repair range $00-$37 (56 bytes, covers full code)
STA $40
@noWrap:
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
DEX
BNE @outer
BNE @top
BEQ @top
