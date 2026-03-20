; Mini Spreader: Minimal self-replicator: copies only its own code + PC save area
; Mini Spreader: minimal self-replicating program
; Lives at offset $E0, just before the register save area ($F9-$FF).
; Copies $E0-$FA (27 bytes) from own page 0 to a random neighbor's page 0.
; No page 2 template needed -- reads directly from live code.
;
; This is the minimum viable replicator: code + the PC bytes ($F9:$FA)
; that point to it. The controller saves/restores PC from $F9:$FA, so
; copying these bytes makes the target execute from $E0 next scheduling.
;
; Total: 25 bytes of code ($E0-$F8), 27 byte-copies per replication.
; Compare: original spreader copies 512 bytes per replication.
.org $00E0
@start:
LDA $FC           ; RNG byte
AND #$03          ; 0-3
CLC
ADC #$01          ; 1-4 (cardinal neighbor)
ASL
ASL               ; target page 0 high byte: $04/$08/$0C/$10
STA @st+2         ; patch STA high byte in copy loop
LDY #$1A          ; copy 27 bytes (Y: $1A down to $00)
@lp:
LDA $E0,Y         ; read own code at $E0+Y
@st:
STA $04E0,Y       ; write to target (high byte patched above)
DEY
BPL @lp           ; Y=$00..$1A inclusive
BMI @start        ; always taken: DEY past 0 sets N flag
