; RPS Blue: Lotka-Volterra predator-prey replicator
; Type 3 (blue). Preys on type 2 (green). Eaten by type 1 (red).
; Copies forward if neighbor is prey (2) or empty (0).
; Skips if neighbor is self (3) or predator (1).
LDA #$03
STA $A5            ; type = 3
LDA #$AA
STA $03A0          ; hue = blue
@start:
LDA $04A5          ; forward neighbor's type
BEQ @copy          ; 0 = empty → copy
CMP #$02
BEQ @copy          ; 2 = green (prey) → copy
BRK
.byte $00          ; yield
@copy:
BRK
.byte $F5          ; copy forward
BNE @start
BEQ @start