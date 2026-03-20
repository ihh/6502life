; Spreader: Copies self to a random cardinal neighbor using RNG
; Random spreader: copies self to a random cardinal neighbor
; Uses RNG byte at $FC to select N/E/S/W (cells 1-4)
; Target cell page 0 high byte: cell 1=$04, 2=$08, 3=$0C, 4=$10
; Self-modifying code patches the STA high bytes in the copy loops
; Reads from page 2 (template); writes to target page 0 + page 2
LDA $FC
AND #$03
CLC
ADC #$01        ; A = 1..4
ASL
ASL             ; A = 4,8,12,16 = high byte of target page 0
STA $17         ; patch high byte of STA at @st0
CLC
ADC #$02        ; high byte of target page 2
STA $20         ; patch high byte of STA at @st1
; Copy template -> target page 0 (execution copy)
LDY #$01
@lp0:
LDA $0201,Y    ; read self page 2 (template)
@st0:
STA $0401,Y    ; target page 0 (high byte is patched)
INY
BNE @lp0
; Copy template -> target page 2 (template copy for further spreading)
@lp1:
LDA $0201,Y    ; read self page 2 (template)
@st1:
STA $0601,Y    ; target page 2 (high byte is patched)
INY
BNE @lp1
; Yield to scheduler
BRK
.byte $01
