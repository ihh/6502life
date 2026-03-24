; Compass Spreader: always copies toward (0,+1) using magnetosensing
; Reads $FA for orientation (0, 4, 8, 12), selects BRK operand
; so the physical copy direction is always (0,+1) regardless of rotation.
; Sets hue=42 (orange) in the RGB bitmap area for visual tracking.
;
; Orientation mapping (which mapped cell reaches physical (0,+1)):
;   orientation 0 ($FA=0):  mapped cell 1 -> BRK $F5
;   orientation 1 ($FA=4):  mapped cell 2 -> BRK $F6
;   orientation 2 ($FA=8):  mapped cell 3 -> BRK $F7
;   orientation 3 ($FA=12): mapped cell 4 -> BRK $F8
LDA #$2A
STA $03A0           ; hue = 42 (orange)
@start:
LDA $FA             ; read orientation (0, 4, 8, or 12)
BEQ @ori0           ; orientation 0: use cell 1
CMP #$04
BEQ @ori1           ; orientation 1: use cell 2
CMP #$08
BEQ @ori2           ; orientation 2: use cell 3
; orientation 3: use cell 4
BRK
.byte $F8           ; copy to mapped cell 4 -> physical (0,+1)
BNE @start
BEQ @start
@ori0:
BRK
.byte $F5           ; copy to mapped cell 1 -> physical (0,+1)
BNE @start
BEQ @start
@ori1:
BRK
.byte $F6           ; copy to mapped cell 2 -> physical (0,+1)
BNE @start
BEQ @start
@ori2:
BRK
.byte $F7           ; copy to mapped cell 3 -> physical (0,+1)
BNE @start
BEQ @start
