; Red: rock-paper-scissors ecology (RED team)
; Copies self to neighbors. Writes red to display name.
; Gets killed by Green (which overwrites it).
; Kills Blue (by overwriting it).
; Type tag at $A5 = 1 (red)
; Display: writes "red" to name area and red bitmap
LDA #$01
STA $A5            ; type tag = 1 (red)
LDA #$72           ; 'r'
STA $03E0
LDA #$65           ; 'e'
STA $03E1
LDA #$64           ; 'd'
STA $03E2
; Red bitmap
LDA #$FF
STA $0380
STA $0381
; Copy to random neighbor
@start:
BRK
.byte $F5          ; copy forward
BNE @start
BEQ @start