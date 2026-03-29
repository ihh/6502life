; Replicator-killer: same pattern as alien-killer, shibboleth $06

@start:
  LDA #$06
  CMP $0401
  BEQ @start

  LDA #$02
  STA $0400
  LDA #$00
  STA $04FA
  STA $04F9

  LDX #32
@copy:
  LDA $00,X
  STA $0400,X
  DEX
  BPL @copy
  BMI @start
