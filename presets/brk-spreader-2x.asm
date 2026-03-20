; BRK Spreader 2x: Copies self to two random cardinal neighbors per cycle
; Two independent noisy copies per execution window — every scheduling
; event produces a copy, doubling the effective replication rate.
@start:
LDA $FC         ; first random byte
AND #$03
CLC
ADC #$F5        ; $F5-$F8
STA @brk1+1     ; patch first BRK operand
LDA $FD         ; second random byte
AND #$03
CLC
ADC #$F5
STA @brk2+1     ; patch second BRK operand
@brk1:
BRK
.byte $F5       ; first copy (patched)
@brk2:
BRK
.byte $F5       ; second copy (patched)
BNE @start
BEQ @start