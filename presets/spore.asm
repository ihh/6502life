; Spore: minimal replicator — copy forward, loop
; 4 bytes: BRK $F5 (copy to cell 1), then unconditional loop.
; After BRK yields, PC is at byte 2. The branch loops back to byte 0.
; At 32 bits of critical code, perfect copy prob ≈ (1-ε)^32 ≈ 98.4%.
; Plus $F9:$FA must be correct (16 more bits) → 97.7%.
@start:
BRK
.byte $F5       ; copy to cell 1 (forward)
BNE @start
BEQ @start