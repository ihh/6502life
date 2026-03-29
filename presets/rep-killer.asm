; Replicator-killer: same as alien-killer but shibboleth $06

; --- Self-check ---
  LDA #$06
  CMP $0401
  BEQ @done

; --- Jam + redirect PC ---
  LDA #$02
  STA $0400
  LDA #$00
  STA $04F9
  STA $04FA

; --- Copy bytes 1-255 ---
  LDX #$01
@copy:
  LDA $00,X
  STA $0400,X
  INX
  BNE @copy

; --- Write byte 0 last ---
  LDA $00
  STA $0400

@done:
  BRK
  .byte $00
