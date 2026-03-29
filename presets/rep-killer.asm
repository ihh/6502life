; Replicator-killer: targets non-self neighbors
;
; Self-check via shibboleth at byte 1 ($06). Copies self over any
; neighbor that doesn't share the shibboleth. JAMs neighbor first,
; then copies, then resets PC and stack.

; --- Self-check: skip if neighbor is already us ---
  LDA #$06            ; our shibboleth (byte 1)
  CMP $0401           ; neighbor's byte 1
  BEQ @done           ; already a clone

; --- JAM the neighbor ---
  LDA #$02            ; JAM opcode
  STA $0400           ; disable neighbor's entry point

; --- Copy self to neighbor ---
  LDX #$00
@copy:
  LDA $00,X
  STA $0400,X
  INX
  BNE @copy

; --- Reset neighbor's registers AFTER copy ---
  LDA #$00
  STA $04F9           ; PC high = 0
  STA $04FA           ; PC low = 0
  LDA #$FF
  STA $04FF           ; S = $FF

@done:
  BRK
  .byte $00
