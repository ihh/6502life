; BRK Spreader: Copies self to a random cardinal neighbor using BRK noisy-copy
; BRK Spreader: uses BRK noisy-copy (operands $31-$38) to replicate
; Much simpler than the byte-by-byte spreader since BRK handles the whole copy
; RNG at $FC gives a random byte; mask to 0-3, add $31 for cells 1-4
; Self-modifying code patches the BRK operand before executing it
@start:
LDA $FC         ; random byte from RNG
AND #$03        ; 0-3
CLC
ADC #$31        ; $31-$34 = noisy copy to cells 1-4
STA $0A         ; patch the BRK operand at offset $0A
BRK
.byte $31       ; placeholder operand, patched by STA above
BNE @start      ; loop (branch if Z clear)
BEQ @start      ; loop (branch if Z set)
