; Bare Replicator: minimal byte-copy loop (8 bytes)
; The simplest self-replicating program that works in the bare-sim.
; Copies all 256 zero-page bytes to the neighbor cell.
; BCC creates an infinite loop (carry flag unaffected by INX).
; B_eff ≈ 62 bits.
@loop:
LDA $00,X       ; B5 00 — load source byte at zero-page + X
STA $0400,X     ; 9D 00 04 — store to neighbor + X
INX             ; E8
BCC @loop       ; 90 F8 — carry never set by INX → infinite loop
