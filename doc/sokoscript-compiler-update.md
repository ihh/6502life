# SokoScript Compiler: Updated Feasibility

The two key limitations from the original investigation are now addressed:

## 1. Synchronous rules → BRK 253 (sync interrupt)

The original limitation: "Synchronous rules have no faithful implementation
due to the lack of global barriers."

**Now solved**: BRK 253 allows cells to request interrupts at periodic
intervals synchronized to global board time. A SokoScript synchronous
rule compiles to:
1. Cell requests sync interrupt with period = 1 rule application cycle
2. All cells with the same period fire at the same global time
3. Scheduler randomly orders them (matching SokoScript's random-order-
   within-sync semantics)

Not perfectly synchronous (cells still execute sequentially within a
tick), but much closer than pure random scheduling. The `implementsSync`
flag must be enabled on the board.

## 2. Absolute-direction rules → magnetosensing

The original limitation: "Absolute-direction rules (>N>, >E>, >S>, >W>)
conflict with random orientation resampling."

**Now solved**: with `magnetosensing: true`, the scheduler writes the
current orientation to $FA. The compiled code reads $FA to determine
which physical direction corresponds to which memory-mapped neighbor.
A lookup table at $E000+ can translate absolute directions to rotated
neighbor indices.

## Conclusion

The SokoScript compiler can now approach **feature-completeness**. The
remaining semantic gaps are minor:
- Sync updates are still sequential (not truly simultaneous), but the
  scheduler randomizes order, matching SokoScript's semantics
- Very complex state expressions may exceed the 736-byte code budget,
  but all existing grammars fit

Estimated effort: 2-4 weeks for a working compiler.
