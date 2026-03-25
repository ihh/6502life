; Compass Spreader: always copies toward (0,+1) using the compass (hasCompass)
; Reads $FA for orientation (0, 4, 8, 12), selects BRK operand
; so the physical copy direction is always (0,+1) regardless of rotation.
; Sets hue=42 (orange) at 0x3FF for visual tracking.
;
; Orientation mapping (which mapped cell reaches physical (0,+1)):
;   orientation 0 ($FA=0):  mapped cell 1 -> BRK $31
;   orientation 1 ($FA=4):  mapped cell 2 -> BRK $32
;   orientation 2 ($FA=8):  mapped cell 3 -> BRK $33
;   orientation 3 ($FA=12): mapped cell 4 -> BRK $34
LDA #$2A
STA $03FF           ; hue = 42 (orange)
@start:
LDA $FA             ; read orientation (0, 4, 8, or 12)
BEQ @ori0           ; orientation 0: use cell 1
CMP #$04
BEQ @ori1           ; orientation 1: use cell 2
CMP #$08
BEQ @ori2           ; orientation 2: use cell 3
; orientation 3: use cell 4
BRK
.byte $34           ; copy to mapped cell 4 -> physical (0,+1)
BNE @start
BEQ @start
@ori0:
BRK
.byte $31           ; copy to mapped cell 1 -> physical (0,+1)
BNE @start
BEQ @start
@ori1:
BRK
.byte $32           ; copy to mapped cell 2 -> physical (0,+1)
BNE @start
BEQ @start
@ori2:
BRK
.byte $33           ; copy to mapped cell 3 -> physical (0,+1)
BNE @start
BEQ @start
