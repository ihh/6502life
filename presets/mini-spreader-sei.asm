; Mini Spreader SEI: Atomic mini-spreader using SEI to protect writes
; Sets the interrupt flag before copying, so if a timer interrupt fires
; mid-copy, all writes are reverted (no partial copies). The copy only
; commits when BRK fires (software interrupt ignores I flag).
;
; Lives at $E0, copies $E0-$FA (27 bytes) from own page 0 to a random
; neighbor. Uses BRK $01 to yield (commits the atomic write batch).
.org $00E0
@start:
SEI               ; protect writes — timer interrupt will revert them
LDA $FC           ; RNG byte
AND #$03          ; 0-3
CLC
ADC #$01          ; 1-4
ASL
ASL               ; target page 0 high byte
STA @st+2         ; patch STA high byte
LDY #$1A          ; copy 27 bytes
@lp:
LDA $E0,Y         ; read own code
@st:
STA $04E0,Y       ; write to target
DEY
BPL @lp
BRK               ; yield — commits writes (BRK ignores I flag)
.byte $01         ; swap with cell 1 to move around
BMI @start        ; always taken after DEY past 0