; Alien-killer: self-referential replicator that only copies over non-self
;
; Uses byte 1 (the shibboleth) as a self-recognition signal. If the
; neighbor's byte 1 matches ours, it's a clone — skip the copy (~16 cycles).
; If it doesn't match, JAM the neighbor's entry point, then copy self over
; it and reset its registers.
;
; Advantage over the simple replicator: wastes ~16 cycles when surrounded
; by clones (vs ~3600 for the blind copier), conserving budget for
; encounters with aliens. The shibboleth propagates through copies
; naturally since it's part of the code.
;
; Memory layout (bare sim):
;   $0000-$03FF = self (cell 0)
;   $0400-$07FF = neighbor (cell 1)
;   $04F9 = neighbor's saved PC high
;   $04FA = neighbor's saved PC low
;   $04FF = neighbor's saved S

; --- Check shibboleth: is neighbor a clone? ---
  LDA #$42            ; A = our shibboleth value (byte 1 of this code)
  CMP $0401           ; compare with neighbor's byte 1
  BEQ @done           ; clone — nothing to do

; --- Phase 1: JAM the neighbor (prevents it executing if we're interrupted) ---
  LDA #$02            ; JAM opcode
  STA $0400           ; overwrite neighbor's entry point

; --- Phase 2: Copy self to neighbor (page 0, 256 bytes) ---
  LDX #$00
@copy:
  LDA $00,X
  STA $0400,X
  INX
  BNE @copy

; --- Phase 3: Reset neighbor's registers AFTER copy ---
; (The copy loop overwrites $04F9-$04FF with our stale register saves;
;  we must fix PC and S afterward so the neighbor boots cleanly.)
  LDA #$00
  STA $04F9           ; PC high = 0
  STA $04FA           ; PC low = 0
  LDA #$FF
  STA $04FF           ; S = $FF

@done:
  BRK
  .byte $00
