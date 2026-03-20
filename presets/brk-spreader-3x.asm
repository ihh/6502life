; BRK Spreader 3x: Copies self to three random cardinal neighbors per cycle
; Three noisy copies over three scheduling events — maximum replication rate.
@start:
LDA $FC
AND #$03
CLC
ADC #$F5
STA @b1+1
LDA $FD
AND #$03
CLC
ADC #$F5
STA @b2+1
LDA $FE
AND #$03
CLC
ADC #$F5
STA @b3+1
@b1:
BRK
.byte $F5
@b2:
BRK
.byte $F5
@b3:
BRK
.byte $F5
BNE @start
BEQ @start