; BRK Spreader 3x: Copies self to three random cardinal neighbors per cycle
; Three noisy copies over three scheduling events — maximum replication rate.
@start:
LDA $FC
AND #$03
CLC
ADC #$31
STA @b1+1
LDA $FD
AND #$03
CLC
ADC #$31
STA @b2+1
LDA $FE
AND #$03
CLC
ADC #$31
STA @b3+1
@b1:
BRK
.byte $31
@b2:
BRK
.byte $31
@b3:
BRK
.byte $31
BNE @start
BEQ @start