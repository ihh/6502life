; Repair: BRK copy + neighbor-read error correction
; Strategy:
;   Phase 0: BRK copy self to forward neighbor (fast, noisy)
;   Phase 1: Read own code from the RIGHT neighbor (cell 2, $0800+)
;            and overwrite self with those bytes (repair from sibling)
;
; If the right neighbor has a copy of us (from a previous BRK copy),
; reading from it repairs any bits that were corrupted by cross-
; contamination. The LDA/STA read is exact (zero noise).
;
; Two independent noisy copies agree on the correct value with
; probability ≈ (1-ε)² + ε²/2 ≈ 1 - ε ≈ 99.95%. So neighbor-read
; repair is nearly as good as majority voting.
;
; Phase selection: toggle $10 each scheduling.
; 14 bytes for copy+toggle, plus repair loop.
@start:
LDA $10
EOR #$01
STA $10
BNE @repair
; Phase 0: copy self to forward neighbor
BRK
.byte $F5
BNE @start
BEQ @start
@repair:
; Phase 1: read code bytes from right neighbor (cell 2 at $0800)
; and overwrite own code with them. This repairs cross-contamination.
; Only repair bytes 0-15 (our code region).
SEI               ; protect repair writes from timer interrupt
LDY #$0F
@rlp:
LDA $0800,Y       ; read from right neighbor
STA $00,Y          ; overwrite own code
DEY
BPL @rlp
BRK               ; commit repairs
.byte $01          ; swap with forward (move around)
BNE @start
BEQ @start