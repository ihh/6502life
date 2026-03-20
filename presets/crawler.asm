; Crawler: Random-walks across the board by swapping with forward neighbor
; Crawler: swaps self with cell 1 (forward neighbor) every interrupt
; Orientation is random each time the cell is scheduled, so the
; direction of "forward" changes randomly -> visible random walk
; Phase 0: noisy copy origin to forward neighbor (so code persists)
; Phase 1: swap entire cell with forward neighbor (actually moves)
; Phase counter at $10, toggled each interrupt
LDA $10
EOR #$01
STA $10
BNE @swap
; Phase 0: noisy copy origin -> cell 1 (BRK $F5)
BRK
.byte $F5   ; noisy copy to cell 1, yield
@swap:
; Phase 1: swap cell 0 and cell 1 (BRK $01 = swap origin with cell 1)
BRK
.byte $01   ; swap cells, yield
