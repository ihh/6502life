; Counter: Increments accumulator and stores to $10
TXA
@loop:
CLC
ADC #$01
STA $10
BNE @loop
