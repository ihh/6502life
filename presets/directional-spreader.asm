; Directional Spreader: copies self forward, then moves forward
; Uses the orientation system — cell 1 is always "forward" relative
; to the cell's randomly assigned orientation each scheduling.
; Alternates: copy forward, then swap forward (move into the copy).
; This creates a spreading wavefront.
; Unlike crawler, this always copies first then moves (no toggle byte).
; The copy+move pair means the original stays behind while a copy
; appears ahead, and then we move into the copy position.
; Net effect: leave a copy behind and advance.
@start:
; Step 1: noisy copy self to forward neighbor
BRK
.byte $31       ; noisy copy origin → cell 1 (forward)
; Step 2: swap self with forward neighbor (move forward)
BRK
.byte $01       ; swap origin ↔ cell 1 (we move into the copy)
; Step 3: do another copy forward from new position
BRK
.byte $31
; Loop
BNE @start
BEQ @start