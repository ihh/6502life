// Preset 6502 programs for the cellular automata board
// All programs avoid 0x00 bytes in the instruction stream (BRK trap)

export const PRESETS = {
    counter: {
        name: 'Counter',
        desc: 'Increments accumulator and stores to $10',
        source: `; Counter: increments A and stores to $10
TXA
@loop:
CLC
ADC #$01
STA $10
BNE @loop`,
    },

    nop: {
        name: 'NOP Sled',
        desc: 'Infinite loop of NOPs',
        source: `; NOP sled
@loop:
NOP
NOP
NOP
NOP
NOP
NOP
NOP
NOP
BNE @loop
BEQ @loop`,
    },

    copier: {
        name: 'Self-Copier',
        desc: 'Copies own code to neighbor cell (East, cell 2)',
        source: `; Copy own code (page 0+1) to cell 2 (East neighbor)
; Cell 2 starts at address $0800 in the memory map
; Copy 512 bytes ($200): page 0 from $0201 and page 1 from $0101
LDY #$01
@loop_p0:
LDA $0201,Y
STA $0801,Y
INY
BNE @loop_p0
@loop_p1:
LDA $0101,Y
STA $0901,Y
INY
BNE @loop_p1
; Done, yield to scheduler
BRK
.byte $01`,
    },

    overwriter: {
        name: 'Overwriter',
        desc: 'Writes a pattern to all 4 cardinal neighbor cells',
        source: `; Write NOP sled to cardinal neighbors (N=1, E=2, S=3, W=4)
; Each cell is at cellIndex * $0400
; N=$0400, E=$0800, S=$0C00, W=$1000
; Write EA (NOP) to first 240 bytes of each
LDX #$01
@outer:
LDY #$EF
LDA #$EA
@inner:
; Compute target page = X * 4
; Store NOP at target + Y offset
STA $0401,Y
DEY
BNE @inner
STA $0401,Y
INX
CPX #$05
BNE @outer
BRK
.byte $01`,
    },

    tumbler: {
        name: 'Tumbler',
        desc: 'Alternates between moving forward and turning (tumble-roll)',
        source: `; Tumbler: swap with North neighbor, then rotate oriented registers
; This creates movement across the board
; Step 1: swap self with North (cell 1)
LDA #$01   ; cell index 1 = North
TAX
LDY #$01   ; swap with self? No - BRK operand = X + 49*Y
; BRK 1 swaps cells X and Y
BRK
.byte $01
; After BRK, scheduler moves us. When we get control again:
; Modify oriented register at $F0 to rotate our "forward" direction
LDA $F0
CLC
ADC #$04   ; rotate by adding to top bits (each unit = ~5.6 degrees)
STA $F0
; Loop
BRK
.byte $01`,
    },

    spreader: {
        name: 'Spreader',
        desc: 'Copies self to a random cardinal neighbor using RNG',
        source: `; Random spreader: copies self to a random cardinal neighbor
; Uses RNG byte at $FC to select N/E/S/W (cells 1-4)
; Target cell page 0 high byte: cell 1=$04, 2=$08, 3=$0C, 4=$10
; Self-modifying code patches the STA high bytes in the copy loops
LDA $FC
AND #$03
CLC
ADC #$01        ; A = 1..4
ASL
ASL             ; A = 4,8,12,16 = high byte of target page 0
STA $17         ; patch high byte of STA at @st0 (offset $15)
CLC
ADC #$01        ; high byte of page 1
STA $20         ; patch high byte of STA at @st1 (offset $1E)
; Copy page 0 (bytes 1-255)
LDY #$01
@lp0:
LDA $0201,Y    ; read self page 0
@st0:
STA $0401,Y    ; target page 0 (high byte at $12 is patched)
INY
BNE @lp0
; Copy page 1 (bytes 1-255)
@lp1:
LDA $0101,Y    ; read self page 1
@st1:
STA $0501,Y    ; target page 1 (high byte at $1D is patched)
INY
BNE @lp1
; Yield to scheduler
BRK
.byte $01`,
    },

    painter: {
        name: 'Painter',
        desc: 'Fills the RGB bitmap area (0x380-0x3BF) with a pattern',
        source: `; Painter: create a pattern in the 16x16 RGB bitmap
; R channel at $380 (32 bytes), G at $3A0, B at $3C0
LDX #$1F
LDA #$FF
@fill_r:
STA $0380,X
DEX
BPL @fill_r
; Green: alternating
LDX #$1F
@fill_g:
TXA
STA $03A0,X
DEX
BPL @fill_g
; Blue: inverse
LDX #$1F
@fill_b:
TXA
EOR #$FF
STA $03C0,X
DEX
BPL @fill_b
; Set name to "painter"
LDA #$70   ; 'p'
STA $03E1
LDA #$61   ; 'a'
STA $03E2
LDA #$69   ; 'i'
STA $03E3
LDA #$6E   ; 'n'
STA $03E4
LDA #$74   ; 't'
STA $03E5
; Yield
BRK
.byte $01`,
    },

    crawler: {
        name: 'Crawler',
        desc: 'Random-walks across the board by swapping with forward neighbor',
        source: `; Crawler: swaps self with cell 1 (forward neighbor) every interrupt
; Orientation is random each time the cell is scheduled, so the
; direction of "forward" changes randomly → visible random walk
; Phase 0: copy own code page to forward neighbor (so it persists)
; Phase 1: swap entire cell with forward neighbor (actually moves)
; Phase counter at $10, toggled each interrupt
LDA $10
EOR #$01
STA $10
BNE @swap
; Phase 0: copy page 0 → cell 1 page 0 (BRK 3)
LDX #$01
DEX          ; X=0 (our page)
LDY #$04    ; cell 1 page 0 = page index 4
BRK
.byte $03   ; copy page X→Y, yield
@swap:
; Phase 1: swap cell 0 and cell 1 (BRK 1)
LDX #$01
DEX          ; X=0 (self)
LDY #$01    ; cell 1 (forward)
BRK
.byte $01   ; swap cells X,Y, yield`,
    },

    knight: {
        name: 'Knight',
        desc: 'Swaps with cells in an L-shaped pattern like a chess knight',
        source: `; Knight: swap with cells at (2,1), (1,2), etc. - L-shaped moves
; Cell 14 = NE^2 = (2,1), Cell 13 = N^2E = (1,2)
; Alternate between these two
LDA $10     ; load move counter
AND #$01    ; alternate
BNE @move2
; Move 1: swap with cell 14
LDX #$0E    ; cell 14
LDY #$01    ; swap with cell 0
BRK
.byte $01
@move2:
; Move 2: swap with cell 13
LDX #$0D    ; cell 13
LDY #$01
BRK
.byte $01
@done:
INC $10     ; increment counter
BRK
.byte $01`,
    },
};

export function listPresets() {
    return Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, desc: p.desc }));
}

export function getPreset(name) {
    const lower = name.toLowerCase();
    return PRESETS[lower] || null;
}
