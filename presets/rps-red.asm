; RPS Red: Lotka-Volterra predator-prey replicator
; Type 1 (red). Preys on type 3 (blue). Eaten by type 2 (green).
; Copies forward if neighbor is prey (3) or empty (0).
; Skips if neighbor is self (1) or predator (2).
LDA #$01
STA $A5            ; type = 1
LDA #$01
STA $03FF          ; hue = red
@start:
LDA $04A5          ; forward neighbor's type
BEQ @copy          ; 0 = empty → copy
CMP #$03
BEQ @copy          ; 3 = blue (prey) → copy
; neighbor is 1 (self) or 2 (predator) or garbage → skip
BRK
.byte $00          ; yield, try different orientation next time
@copy:
BRK
.byte $F5          ; copy forward
BNE @start
BEQ @start