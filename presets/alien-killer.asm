; Alien-killer: self-referential replicator that only copies over non-self
;
; Runs as a continuous loop (never BRKs). This protects against PC
; corruption when a neighbor overwrites our register save area.
;
; Memory layout (bare sim):
;   $0000-$03FF = self (cell 0)
;   $0400-$07FF = neighbor (cell 1)

@start:
; --- Check shibboleth ---
  LDA #$42            ; our shibboleth (byte 1)
  CMP $0401           ; neighbor's byte 1
  BEQ @start          ; clone — loop

; --- Jam neighbor: write JAM to entry + redirect PC ---
  LDA #$02            ; JAM opcode
  STA $0400
  LDA #$00
  STA $04FA           ; PC low = 0
  STA $04F9           ; PC high = 0

; --- Copy bytes 0-32, storing byte zero last ---
  LDX #32
@copy:
  LDA $00,X
  STA $0400,X
  DEX
  BPL @copy
  BMI @start
