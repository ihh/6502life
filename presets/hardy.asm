; Hardy: minimal deterministic 4-way replicator
; Cycles through copying to N, E, S, W on successive schedulings.
; 10 bytes total — smallest possible multi-directional spreader.
; Error budget: (1-ε)^80 ≈ 96.2% perfect copies at ε=1/2048.
@start:
BRK
.byte $F5       ; copy to N, yield
BRK
.byte $F6       ; copy to E, yield
BRK
.byte $F7       ; copy to S, yield
BRK
.byte $F8       ; copy to W, yield
BNE @start
BEQ @start