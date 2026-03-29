# ROM Geometry Tables: A Programmer's Guide

The 6502life VM provides read-only lookup tables at `$E000`-`$EE3F` that
encode the geometry of the 7x7 neighborhood. These tables, combined with
the oriented registers at `$F0`-`$F8` and the optional compass byte at
`$FA`, let programs reason about spatial relationships without hardcoding
coordinate math.

This guide is for organism designers, compiler writers, and code generators
targeting the 6502life VM.

## Cell indexing

The 49 cells in the 7x7 neighborhood are numbered in spiral order from the
origin:

```
 idx  (dx,dy)  name
  0   ( 0, 0)  self
  1   ( 0,+1)  N
  2   (+1, 0)  E
  3   ( 0,-1)  S
  4   (-1, 0)  W
  5   (+1,+1)  NE
  6   (+1,-1)  SE
  7   (-1,-1)  SW
  8   (-1,+1)  NW
  9   ( 0,+2)  N2
 10   (+2, 0)  E2
 11   ( 0,-2)  S2
 12   (-2, 0)  W2
 ...
 48   (-3,+3)  corner
```

Each cell occupies 1024 bytes. Cell `n` starts at address `n * 1024`
(`n << 10`). The 4 cardinal neighbors are cells 1-4; diagonals are 5-8.

## Oriented registers ($F0-$F8)

The top 6 bits of bytes at `$F0`-`$F8` are automatically rotated by the
memory mapper to match the current orientation. This means a program can
store a cell index in an oriented register and it will remain valid across
orientation changes.

**Encoding:** `(cell_index << 2) | low_2_bits`

The low 2 bits are untouched; the top 6 bits encode a cell index (0-48).
When the orientation changes, the mapper rotates the cell index, so the
register always points to the same _relative_ position.

**Use case:** Store a "target direction" in `$F0`. After the next interrupt,
the program wakes with a different orientation, but `$F0` still points to
the same neighbor relative to the program's frame. No compass needed.

```asm
; Store "east neighbor" as a persistent direction
LDA #(2 << 2)    ; cell 2 = (+1,0), shifted left 2
STA $F0           ; auto-rotated on next context switch
; ... later, after interrupt ...
LDA $F0           ; still points to "east" in our rotated frame
LSR               ; shift right 2 to get cell index
LSR
; A = cell index of our east neighbor (in current orientation)
```

## ROM table layout

Each table row is 64 bytes. Row address = `$E000 + row * 64`. Column = cell
index (0-48). Columns 49-63 are padding (return 0 or 0xFF).

| Address   | Row | Operation                          |
|-----------|-----|------------------------------------|
| `$E000`   | 0   | Translate by cell 0 (identity)     |
| `$E040`   | 1   | Translate by cell 1 = (0,+1)       |
| `$E080`   | 2   | Translate by cell 2 = (+1,0)       |
| ...       | j   | Translate by cell j                |
| `$EC40`   | 49  | Rotate 90 deg clockwise            |
| `$EC80`   | 50  | Rotate 180 deg                     |
| `$ECC0`   | 51  | Rotate 270 deg clockwise           |
| `$ED00`   | 52  | Reflect about x-axis               |
| `$ED40`   | 53  | Reflect about y-axis               |
| `$ED80`   | 54  | X coordinate of cell (+ 3)         |
| `$EDC0`   | 55  | Y coordinate of cell (+ 3)         |
| `$EE00`   | 56  | (x,y) coords -> cell index         |

Results that fall outside the 7x7 neighborhood return `$FF` (bit 7 set).
Programs should test bit 7 before using a result as a cell index.

## Translation tables (rows 0-48)

`translate[j][i]` returns the cell index of the cell at position
`vec(i) + vec(j)`. In other words: "starting at cell j, go to where cell i
would be relative to origin." Returns `$FF` if the result is outside the
neighborhood.

**Common use: vector addition.**

```asm
; Where is cell i relative to cell j?
; Answer: LDA $E000 + j*64 + i  (if j,i both < 49)
; Example: cell 1's east neighbor = translate[1][2]
LDA $E052         ; $E000 + 1*64 + 2 = $E042... wait
```

Actually, the table address is `$E000 + j * 64`, and you index by `i`:

```asm
; Find translate[j][i]:
;   base = $E000 + j*64 (high byte varies, low byte = j << 6)
;   result = base[i]
; For small j (0-3), use absolute indexed:
LDX #2            ; i = cell 2
LDA $E040,X       ; translate[1][2] = cell at (0,+1)+(+1,0) = (+1,+1) = cell 5 (NE)
```

**Use case: find a cell's neighbor's neighbor.**

```asm
; I'm at cell 0. My north neighbor is cell 1.
; What is cell 1's east neighbor? (= my NE neighbor, cell 5)
LDX #2            ; east = cell index 2
LDA $E040,X       ; translate[1][2] -> 5
; A = 5 (NE)
```

**Use case: check if two cells are adjacent.**

The translation table makes this easy: `translate[a][b]` gives the cell
that is `vec(a) + vec(b)` from origin. But to check adjacency directly,
compare their coordinate difference.

## Rotation tables (rows 49-51)

`rotate90[i]` returns the cell index after rotating cell i by 90 deg clockwise.

```asm
; Rotate cell index by 90 degrees:
LDX #1            ; cell 1 = N = (0,+1)
LDA $EC40,X       ; rotate90[1] -> 2 (E = (+1,0))
; Rotating N by 90 CW gives E. Correct.

; Rotate by 180:
LDX #1
LDA $EC80,X       ; rotate180[1] -> 3 (S)

; Rotate by 270 (= 90 CCW):
LDX #1
LDA $ECC0,X       ; rotate270[1] -> 4 (W)
```

**Use case: iterate over all 4 cardinal directions.**

```asm
; Start with direction in X
LDX #1              ; begin with N
@loop:
; ... do something with cell X ...
; Rotate to next direction
LDA $EC40,X         ; rotate90[X]
TAX
CPX #1              ; back to start?
BNE @loop
```

## Reflection tables (rows 52-53)

`reflectX[i]` reflects cell i about the x-axis (flips y coordinate).
`reflectY[i]` reflects about the y-axis (flips x coordinate).

```asm
; Reflect cell 1 (N = (0,+1)) about x-axis:
LDX #1
LDA $ED00,X       ; reflectX[1] -> 3 (S = (0,-1))
```

## Coordinate tables (rows 54-55)

`xcoord[i]` returns the x coordinate of cell i, plus 3 (range 0-6).
`ycoord[i]` returns the y coordinate of cell i, plus 3 (range 0-6).

```asm
; Get (x,y) of cell 5 (NE = (+1,+1)):
LDX #5
LDA $ED80,X       ; xcoord[5] -> 4 (= +1 + 3)
LDA $EDC0,X       ; ycoord[5] -> 4 (= +1 + 3)
```

The origin (cell 0) is at coordinate (3,3).

## Coordinate-to-index table (row 56)

`coord2idx[(x+3) + (y+3)*8]` returns the cell index at coordinates (x,y),
where -3 <= x,y <= 3. Returns `$FF` if out of range.

The table is 64 bytes, laid out as an 8x8 grid with row 7 and column 7 as
padding (all `$FF`).

```asm
; Find the cell index at relative offset (dx, dy):
; index = $EE00 + (dx+3) + (dy+3)*8
; Example: (dx=+1, dy=-1) -> $EE00 + 4 + 2*8 = $EE14
LDA $EE14         ; -> 6 (SE)
```

**Use case: convert compass-adjusted coordinates to a cell index.**

## Compass ($FA) and absolute directions

When `hasCompass` is enabled, the scheduler writes `orientation << 2` to
`$FA` in cell 0's memory each quantum. Orientation is 0-3:

| Orientation | Rotation | $FA value |
|-------------|----------|-----------|
| 0           | 0 deg    | $00       |
| 1           | 90 deg   | $04       |
| 2           | 180 deg  | $08       |
| 3           | 270 deg  | $0C       |

The program sees its neighborhood rotated by this amount. To access an
absolute direction (e.g. "true north"), it must counter-rotate.

**Approach: compass lookup table.**

Build a 16-byte table mapping `(orientation, direction) -> local index`:

```
; For each orientation (0-3) x direction (S=0,E=1,N=2,W=3):
; local_idx = ((dir - orient + 4) % 4) + 1
compass_tbl:
  .byte 1,2,3,4   ; orient 0: S=1 E=2 N=3 W=4
  .byte 4,1,2,3   ; orient 1: S=4 E=1 N=2 W=3
  .byte 3,4,1,2   ; orient 2: S=3 E=4 N=1 W=2
  .byte 2,3,4,1   ; orient 3: S=2 E=3 N=4 W=1
```

Then look up `compass_tbl[$FA + dir_offset]`:

```asm
; Get the local cell index for absolute North (dir offset = 2):
LDX $FA           ; orientation * 4 (0, 4, 8, or 12)
LDA compass_tbl+2,X  ; local index for absolute N
; A = local spiral index. Use to compute cell base address.
```

**Approach: use ROM rotation tables directly.**

The ROM rotation tables can counter-rotate a cell index. If the program
knows it wants "the cell that would be at index 1 if orientation were 0,"
it can apply the inverse rotation:

```asm
; I want absolute South (idx 1 at orient 0).
; At orient R, I need inverseRotate[R][1].
; inverseRotate = rotate by (4-R), i.e. rotate270 for R=1, rotate180 for R=2, etc.
; Read $FA to get R, then dispatch:
LDA $FA
BEQ @r0           ; orient 0: no rotation needed
CMP #$04
BEQ @r1           ; orient 1: apply rotate270
CMP #$08
BEQ @r2           ; orient 2: apply rotate180
; orient 3: apply rotate90
LDX #1
LDA $EC40,X       ; rotate90[1]
JMP @done
@r2:
LDX #1
LDA $EC80,X       ; rotate180[1]
JMP @done
@r1:
LDX #1
LDA $ECC0,X       ; rotate270[1]
JMP @done
@r0:
LDA #1            ; no rotation
@done:
; A = local cell index for absolute South
```

The lookup-table approach is more compact.

## Computing cell base addresses at runtime

Cell base address = `cell_index * 1024`. Since 1024 = `$0400`, the high
byte of the address is `cell_index * 4`, and the low byte is always `$00`.

```asm
; Convert cell index (in A) to base address high byte:
ASL               ; * 2
ASL               ; * 4
; A = high byte of cell base address. Low byte = $00.
; Store in a zero-page pointer for indirect addressing:
STA $02           ; high byte
LDA #$00
STA $01           ; low byte
; Now ($01) points to the cell's base address.
; Access cell data with (indirect),Y:
LDY #$A5          ; TYPE_TAG_OFFSET
LDA ($01),Y       ; read type tag of the resolved cell
```

This is the key technique for compass-aware neighbor access: resolve the
absolute direction to a local cell index, convert to a base address, and
use indirect addressing to read/write the cell's data.

## Pattern: scanning all 4 cardinal neighbors

```asm
LDX #1              ; start with cell 1 (N)
@scan:
; Read neighbor's type tag
LDA $04A5           ; cell 1 type tag (hardcoded for X=1)
; ... but for variable X, need indirect addressing:
; Better: use the ROM to compose operations.
; Store cell index, compute base addr, use indirect.
STX $10             ; save current direction index
TXA
ASL
ASL                 ; A = base addr high byte
STA $02
LDA #$00
STA $01
LDY #$A5            ; TYPE_TAG_OFFSET
LDA ($01),Y         ; read type tag
; ... process ...
LDX $10             ; restore direction index
LDA $EC40,X         ; rotate90 to next direction
TAX
CPX #1              ; wrapped around?
BNE @scan
```

## Pattern: check if any neighbor has a specific type

```asm
; Check all 4 cardinal neighbors for type tag = $03
LDX #1
@check:
TXA
ASL
ASL
STA $02
LDA #$00
STA $01
LDY #$A5
LDA ($01),Y
CMP #$03
BEQ @found
LDA $EC40,X
TAX
CPX #1
BNE @check
; Not found — fall through
JMP @no_match
@found:
; X = cell index of matching neighbor
```

## Pattern: move toward a target using translation

```asm
; Cell 0 has stored a "target cell index" in $F0 (oriented register).
; To move one step toward it, check each cardinal direction:
; the direction d where translate[d][target] has minimum distance
; (or just check if translate[d] brings us closer).
; Simpler: if target IS a cardinal neighbor, just BRK-swap with it.
LDA $F0
LSR
LSR                 ; A = target cell index (un-rotated by hardware)
CMP #1
BEQ @swap_1         ; target is cell 1, swap with it
CMP #2
BEQ @swap_2
; ... etc
```

## Summary of key addresses

| Address     | Contents                                      |
|-------------|-----------------------------------------------|
| `$0000`     | Cell 0 (self) base                            |
| `$0400`     | Cell 1 base                                   |
| `$00A0`     | Key input buffer (compiler convention)        |
| `$00A1`     | Cell unique ID (compiler convention)          |
| `$00A5`     | Type tag (compiler convention)                |
| `$00F0-F8`  | Oriented registers (auto-rotated)             |
| `$00FA`     | Compass byte (orientation << 2)               |
| `$00FC-FF`  | RNG bytes (refreshed each interrupt)          |
| `$E000`     | Translation tables (49 rows x 64 bytes)       |
| `$EC40`     | Rotate 90 deg                                 |
| `$EC80`     | Rotate 180 deg                                |
| `$ECC0`     | Rotate 270 deg                                |
| `$ED00`     | Reflect X                                     |
| `$ED40`     | Reflect Y                                     |
| `$ED80`     | X coordinates                                 |
| `$EDC0`     | Y coordinates                                 |
| `$EE00`     | Coord (x,y) -> cell index                     |
