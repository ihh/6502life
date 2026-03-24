; BRK-Activator: Drives board toward B state (byte[0]=00, byte[1]!=00)
; This is simply the nano replicator — a minimal BRK copier.
; byte[0]=00 (BRK), byte[1]=$31 (copy operand). Each copy produces
; another B-state cell. The chain reaction drives the board to ~100% B.
; Uses BRK-first design: robust to PC corruption via BNE/BEQ loop.
; 6 bytes — identical to nano.asm.
@start:
BRK
.byte $31          ; noisy copy to cell 1 (forward), yield
BNE @start
BEQ @start
