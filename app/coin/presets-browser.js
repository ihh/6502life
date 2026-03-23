/**
 * Browser-compatible preset sources for 6502coin PWA.
 * Inlined from presets/*.asm to avoid Node fs dependency.
 */

export const PRESETS = {
  nano: {
    name: 'Nano Replicator',
    desc: 'Minimal BRK spreader (6 bytes)',
    source: `; Nano Replicator: minimal BRK spreader (6 bytes)
@start:
BRK
.byte $F5
BNE @start
BEQ @start`
  },
  'nano-2x': {
    name: 'Nano 2x',
    desc: '8-byte BRK spreader, two directions',
    source: `; Nano 2x: 8-byte BRK spreader, two directions
@start:
BRK
.byte $F5
BRK
.byte $F6
BNE @start
BEQ @start`
  },
  spreader: {
    name: 'Spreader',
    desc: 'Copies self to a random cardinal neighbor using RNG',
    source: `; Spreader: Copies self to a random cardinal neighbor using RNG
LDA $FC
AND #$03
CLC
ADC #$01
ASL
ASL
STA $17
CLC
ADC #$02
STA $20
LDY #$01
@lp0:
LDA $0201,Y
@st0:
STA $0401,Y
INY
BNE @lp0
@lp1:
LDA $0201,Y
@st1:
STA $0601,Y
INY
BNE @lp1
BRK
.byte $01`
  },
  copier: {
    name: 'Self-Copier',
    desc: 'Copies own code to neighbor cell (East)',
    source: `; Self-Copier: Copies own code to neighbor cell (East, cell 2)
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
BRK
.byte $01`
  },
  tumbler: {
    name: 'Tumbler',
    desc: 'Alternates between moving forward and turning',
    source: `; Tumbler: Alternates between moving forward and turning
BRK
.byte $01
LDA $F0
CLC
ADC #$04
STA $F0
BRK
.byte $01`
  },
  crawler: {
    name: 'Crawler',
    desc: 'Random-walks across the board',
    source: `; Crawler: Random-walks across the board
LDA $10
EOR #$01
STA $10
BNE @swap
BRK
.byte $F5
@swap:
BRK
.byte $01`
  },
  counter: {
    name: 'Counter',
    desc: 'Increments accumulator and stores to $10',
    source: `; Counter: Increments accumulator and stores to $10
TXA
@loop:
CLC
ADC #$01
STA $10
BNE @loop`
  },
  painter: {
    name: 'Painter',
    desc: 'Fills the RGB bitmap area with a pattern',
    source: `; Painter: Fills the RGB bitmap area with a pattern
LDX #$1F
LDA #$FF
@fill_r:
STA $0380,X
DEX
BPL @fill_r
LDX #$1F
@fill_g:
TXA
STA $03A0,X
DEX
BPL @fill_g
LDX #$1F
@fill_b:
TXA
EOR #$FF
STA $03C0,X
DEX
BPL @fill_b
BRK
.byte $01`
  },
  knight: {
    name: 'Knight',
    desc: 'Swaps with cells in an L-shaped pattern',
    source: `; Knight: Swaps with cells in an L-shaped pattern
LDA $10
AND #$01
BNE @move2
BRK
.byte $0E
@move2:
BRK
.byte $0D
@done:
INC $10
BRK
.byte $01`
  },
  red: {
    name: 'Red',
    desc: 'Rock-paper-scissors ecology (RED team)',
    source: `; Red: hue=1 (≈0° red)
LDA #$01
STA $03A0
@start:
BRK
.byte $F5
BNE @start
BEQ @start`
  },
  green: {
    name: 'Green',
    desc: 'Rock-paper-scissors ecology (GREEN team)',
    source: `; Green: hue=85 (≈120° green)
LDA #$55
STA $03A0
@start:
BRK
.byte $F5
BNE @start
BEQ @start`
  },
  blue: {
    name: 'Blue',
    desc: 'Rock-paper-scissors ecology (BLUE team)',
    source: `; Blue: hue=170 (≈240° blue)
LDA #$AA
STA $03A0
@start:
BRK
.byte $F5
BNE @start
BEQ @start`
  }
};

export function getPreset(name) {
  return PRESETS[name.toLowerCase()] || null;
}

export function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, desc: p.desc }));
}
