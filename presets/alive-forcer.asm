; Alive-Forcer: Drives board toward A state (byte[0] != 00)
; BRK-first: copy self to cell 1, then write NOP ($EA) to cell 2's
; byte[0] and reset its PC to 0. This forces cell 2 into A state.
; Note: the forcer itself is B-state (byte[0]=00), but its copies
; write NOP to their neighbors' byte[0], converting them to A.
; 22 bytes.
@start:
BRK
.byte $F5          ; noisy copy to cell 1 (forward), yield
LDA #$EA           ; NOP opcode = non-zero (alive)
STA $0800          ; cell 2 byte[0] = NOP
STA $0C00          ; cell 3 byte[0] = NOP
LDA #$00
STA $08F9          ; cell 2 PCHI = 0
STA $08FA          ; cell 2 PCLO = 0
BNE @start
BEQ @start
