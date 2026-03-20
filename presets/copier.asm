; Self-Copier: Copies own code to neighbor cell (East, cell 2)
; Copy own code from page 2 (template) to cell 2 (East neighbor)
; Cell 2 starts at address $0800 in the memory map
; Loop 1: template (page 2) -> target page 0 (execution copy)
; Loop 2: template (page 2) -> target page 2 (template copy)
LDY #$01
@loop_p0:
LDA $0201,Y
STA $0801,Y
INY
BNE @loop_p0
@loop_p1:
LDA $0201,Y
STA $0A01,Y
INY
BNE @loop_p1
; Done, yield to scheduler
BRK
.byte $01
