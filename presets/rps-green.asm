; RPS Green: Lotka-Volterra predator-prey replicator
; Type 2 (green). Preys on type 1 (red). Eaten by type 3 (blue).
; Copies forward if neighbor is prey (1) or empty (0).
; Skips if neighbor is self (2) or predator (3).
LDA #$02
STA $A5            ; type = 2
LDA #$55
STA $03FF          ; hue = green
@start:
LDA $04A5          ; forward neighbor's type
BEQ @copy          ; 0 = empty → copy
CMP #$01
BEQ @copy          ; 1 = red (prey) → copy
BRK
.byte $00          ; yield
@copy:
BRK
.byte $31          ; copy forward
BNE @start
BEQ @start