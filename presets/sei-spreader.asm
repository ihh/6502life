; SEI Spreader: atomic exact-copy replicator starting at $00
; SEI protects writes from timer-interrupt reversion.
; LDA/STA copy has zero noise — perfect fidelity.
; BRK commits writes (ignores I flag) and yields.
;
; Copies bytes $00-$1F (32 bytes: code + padding) plus $F9-$FA (PC save)
; to a random cardinal neighbor.
;
; Strategy: SEI, copy code region, write PC bytes, BRK to commit+yield.
; The PC write ($F9:$FA = $00:$00) ensures the copy starts executing
; from byte 0 on its next scheduling.
@start:
SEI               ; atomic mode
LDA $FC           ; RNG -> random neighbor
AND #$03
CLC
ADC #$01          ; 1-4
ASL
ASL               ; high byte of target cell page 0
STA @st+2         ; patch STA in copy loop
STA @pchi+2       ; patch STA for PC high byte write
STA @pclo+2       ; patch STA for PC low byte write
; Copy code: bytes $00-$1F
LDY #$1F
@lp:
LDA $00,Y         ; read own zero page (exact copy)
@st:
STA $0400,Y       ; write to target (high byte patched)
DEY
BPL @lp
; Set target's PC to $0000 (entry point)
LDA #$01          ; PCLO = $01 (skip past the BRK at byte 0... wait, $00 IS a BRK)
; Actually we want PC = address of @start. If @start is at $00, PC should be $00.
; But byte $00 of this program is SEI ($78), not BRK. The controller saves PC
; pointing to wherever execution was interrupted. We need PC = $0000.
; PCHI ($F9) = $00, PCLO ($FA) = $00. But $00 in the STA operand IS a BRK...
; Use Y register (Y = $FF after the DEY/BPL loop exits at Y=-1... no, BPL
; exits when Y goes negative, so Y=$FF. We need $00.)
; Trick: X was loaded with... no. Let's use a different approach.
; STZ doesn't exist on NMOS 6502. Let's LDA #$00... but $00 is BRK in the stream.
; Use: TYA after setting Y=0, or LDA an address known to contain $00.
; Simplest: after BPL exits, Y=$FF. INC Y? No INY instruction.
INY               ; Y was $FF, now Y=$00
TYA               ; A = $00
@pchi:
STA $04F9         ; target PCHI = $00 (high byte patched)
@pclo:
STA $04FA         ; target PCLO = $00 (high byte patched)
BRK               ; commit atomic writes + yield
.byte $01         ; swap with cell 1
BNE @start
BEQ @start