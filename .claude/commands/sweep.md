Run a parameter sweep for replicator viability.

Arguments: sweep type and options
  branch [--inc INX|DEX] — sweep all 8 branch opcodes
  addr [--branch $90] — sweep address values 0-255
  prefix — sweep all 256 prefix bytes (before the copy loop)
  insert <pos> — sweep all 256 bytes inserted at slide position 0-3
  multibyte <pos> — sweep safe multi-byte opcodes at slide position
  full — full branch × inc sweep (16 combinations)

Steps:
1. Parse the sweep type and options
2. Run the appropriate sweep function from dfa/experiment.js or dfa/multibyte-slides.js
3. Report results as a table: opcode, spread, viable rate, name
4. Classify into safe/risky/lethal tiers
5. Compare to theoretical predictions where available

Key imports:
- `dfa/experiment.js` (sweepBranch, sweepAddr, sweepInc, fullSweep, etc.)
- `dfa/multibyte-slides.js` (sweepMultibyteSlides)
