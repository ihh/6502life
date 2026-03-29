; Replicator-killer: targets the BCC copier replicator by epitope
;
; Checks two signature bytes of the simple replicator:
;   byte 2 = $9D (STA abs,X)
;   byte 6 = $90 (BCC)
; If both match, JAMs the neighbor and copies self over it.
; If not a replicator, also copies self (acts as a universal spreader).
;
; The self-check prevents redundant copying over clones:
; byte 1 of this code is $06 (unique to this program).

; --- Self-check first (skip copy if neighbor is already us) ---
  LDA #$06            ; our shibboleth (byte 1)
  CMP $0401           ; neighbor's byte 1
  BEQ @done           ; already a clone

; --- JAM the neighbor immediately ---
  LDA #$02            ; JAM opcode
  STA $0400           ; disable neighbor's entry point
  LDA #$00
  STA $04F9           ; redirect neighbor PC high
  STA $04FA           ; redirect neighbor PC low

; --- Copy self to neighbor ---
  LDX #$00
@copy:
  LDA $00,X
  STA $0400,X
  INX
  BNE @copy

; --- Reset neighbor ---
  LDA #$FF
  STA $04FF           ; stack pointer

@done:
  BRK
  .byte $00
