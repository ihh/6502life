Check if a hex byte sequence is a viable self-replicating program.

Arguments: hex string (space-separated bytes, e.g. "B5 00 9D 00 04 E8 90 F8")

Steps:
1. Parse the hex string into a Uint8Array
2. Run simulateCandidate with passes=100, seed=42
3. Report: spread count, copied (boolean), fidelity, functional cell count
4. Disassemble the bytes (show what the CPU would execute)
5. Check against the WFST: does the opcode reviewer accept this sequence?

Use `node --input-type=module`. Key imports:
- `dfa/simulate.js` (simulateCandidate)
- `dfa/reviewers/opcode.js` or `dfa/reviewers/opcode-multibyte.js`

Example: /viable B5 00 9D 00 04 E8 50 F8
