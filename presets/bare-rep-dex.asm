; Bare Replicator (DEX+BCC variant): byte-copy loop (8 bytes)
; Uses DEX instead of INX. Copies bytes in reverse order starting
; from byte 0, then 255, 254, ..., 1. BCC loops forever (carry
; unaffected by DEX).
@loop:
LDA $00,X       ; B5 00
STA $0400,X     ; 9D 00 04
DEX             ; CA
BCC @loop       ; 90 F8
