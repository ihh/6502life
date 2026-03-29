; Alien-killer: self-referential replicator that only copies over non-self
;
; Strategy: check shibboleth (byte 1) to recognize clones. If neighbor
; is not a clone: JAM it, redirect its PC, copy self over it. Byte 0 is
; written LAST so the JAM protects the neighbor throughout the copy.
; If interrupted at any point, neighbor has JAM at byte 0 and PC=0.
;
; Memory layout (bare sim):
;   $0000-$03FF = self (cell 0)
;   $0400-$07FF = neighbor (cell 1)

; --- Check shibboleth ---
  LDA #$42            ; our shibboleth (byte 1)
  CMP $0401           ; neighbor's byte 1
  BEQ @done           ; clone — skip

; --- Jam neighbor: write JAM to entry + redirect PC ---
  LDA #$02            ; JAM opcode
  STA $0400           ; neighbor can't execute now
  LDA #$00
  STA $04F9           ; PC high = 0
  STA $04FA           ; PC low = 0 (points at JAM)

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
