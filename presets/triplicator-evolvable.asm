; Triplicator with evolvable repair rate
; BRK copy FIRST, then repair N bytes in a loop, then back to top.
; N is stored as a byte at offset $42 (outside code range $00-$3F).
; During noisy copies, N mutates along with the rest of the genome.
; Natural selection acts on N: too low = dies to corruption,
; too high = timer fires mid-repair = wasted scheduling.
; 3 copies at pages 0, 2, 3. Majority vote.
; Repair index at $40, temp at $41, N at $42.
@top:
BRK
.byte $F5           ; copy to forward neighbor — fires every scheduling
; Load evolvable repair count
LDX $42             ; N stored at byte $42
BEQ @skip           ; if N=0, skip repair entirely
@outer:
DEC $40
BPL @noWrap
LDA #$42            ; repair range $00-$42 (covers code + N byte at $42)
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
@skip:
BNE @top
BEQ @top
