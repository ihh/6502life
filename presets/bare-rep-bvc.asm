; Bare Replicator (BVC variant): byte-copy loop (8 bytes)
; Same as bare-rep but uses BVC instead of BCC.
; Overflow flag unaffected by INX → infinite loop.
@loop:
LDA $00,X       ; B5 00
STA $0400,X     ; 9D 00 04
INX             ; E8
BVC @loop       ; 50 F8
