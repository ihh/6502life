; Mini Spreader SEI: atomic exact-copy replicator
; SEI protects writes from timer-interrupt reversion.
; LDA/STA copy has zero noise — perfect fidelity.
; BRK commits writes (ignores I flag) and yields.
;
; Lives at $E0, copies $E0-$FA (27 bytes: code + PC save area).
; 25 bytes of code, 27 bytes copied per replication.
.org $00E0
@start:
SEI               ; atomic mode — timer interrupt reverts writes
LDA $FC           ; RNG byte
AND #$03          ; 0-3
CLC
ADC #$01          ; 1-4
ASL
ASL               ; target page 0 high byte: $04/$08/$0C/$10
STA @st+2         ; patch STA high byte in copy loop
LDY #$1A          ; copy 27 bytes (Y: $1A down to $00)
@lp:
LDA $E0,Y         ; read own code (exact, no noise)
@st:
STA $04E0,Y       ; write to target (high byte patched)
DEY
BPL @lp           ; Y=$00..$1A inclusive
BRK               ; commit atomic writes + yield
.byte $01         ; swap with cell 1 (move around)
BMI @start        ; always taken: DEY past 0 sets N