; Replicator-killer: same as alien-killer but shibboleth $06

; --- Check shibboleth ---
  LDA #$06
  CMP $0401
  BEQ @done

; --- Jam neighbor ---
  LDA #$02
  STA $0400
  LDA #$00
  STA $04F9
  STA $04FA

; --- Copy bytes 0-30 (@done), storing byte zero last
  LDX #30
@copy:
  LDA $00,X
  STA $0400,X
  DEX
  BPL @copy

@done:
  BRK
  .byte $00
