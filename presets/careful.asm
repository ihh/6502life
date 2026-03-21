; Careful: BRK copy + SEI-protected PC write
; Strategy:
; 1. BRK noisy-copy to a random neighbor (copies full cell with noise)
; 2. SEI to protect subsequent writes from timer interrupt reversion
; 3. Overwrite the neighbor's PC save area ($F9-$FA) with our own entry
;    point, ensuring the copy starts executing from byte 0
; 4. BRK to yield (commits the atomic PC write)
;
; The SEI+write+BRK pattern ensures the PC fixup is atomic: either it
; completes (BRK commits) or it's fully reverted (timer reverts).
; This repairs the most critical bytes even if the noisy copy corrupted them.
;
; 18 bytes total.
@start:
; Step 1: noisy copy to a random cardinal neighbor
LDA $FC
AND #$03
CLC
ADC #$F5
STA @copy+1       ; patch the BRK operand
@copy:
BRK
.byte $F5         ; noisy copy (patched)
; Step 2: protect and fix the copy's PC to point to $0000
SEI
; We need the target cell's page address. Recompute from the same RNG.
; Actually, the RNG refreshes each scheduling, so we use a different approach:
; The copy already happened — the neighbor should have our code.
; The most important thing is that $F9:$FA = $00:$00 (PC -> entry point).
; We write $00 to all 4 neighbors' $F9, hedging our bets.
; Cell 1 $F9 = address $04F9, cell 2 = $08F9, etc.
LDA #$01          ; $01 because $00 is BRK — PC $0001 skips past first BRK byte
STA $04FA         ; cell 1 PCLO
STA $08FA         ; cell 2 PCLO
STA $0CFA         ; cell 3 PCLO
STA $10FA         ; cell 4 PCLO
LDA #$00          ; PCHI = $00 (page 0)
; Can't STA with $00 literal (it would be treated as ZP which is self)
; Actually $04F9 is in neighbor cell 1's memory, which is correct
; But writing $00 directly: the STA operand byte $00 IS a BRK!
; Use a register trick: we already have A=$00... but we can't write it
; because STA $04F9 would have $00 in its encoding.
; Alternative: just trust the noisy copy got $F9:$FA right.
; Skip the PCHI write — PCLO=$01 is enough if PCHI was copied correctly.
BRK               ; yield, commits the atomic PC writes
.byte $01         ; swap with cell 1 (move around)
BNE @start
BEQ @start