"""Cross-validation of JAX 6502 against Sfotty test vectors."""

import json
import sys
import os
import numpy as np

# Check JAX availability
try:
    import jax
    import jax.numpy as jnp
    HAS_JAX = True
except ImportError:
    HAS_JAX = False
    print("JAX not available — running with numpy stubs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if HAS_JAX:
    from jax6502.cpu import step_one_instruction


def load_test_cases():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'cpu', 'sfotty-test-cases.json')
    with open(path) as f:
        return json.load(f)


def run_test(tc):
    """Run one test case. Returns (passed, error_msg)."""
    setup = tc['setup']
    expected = tc['expected']

    # Build 64KB memory (test cases use full address space)
    memory = np.zeros(65536, dtype=np.uint8)
    for addr_str, val in setup['memory'].items():
        memory[int(addr_str)] = val

    pc = jnp.uint16(setup['PC'])
    a = jnp.uint8(setup['A'])
    x = jnp.uint8(setup['X'])
    y = jnp.uint8(setup['Y'])
    s = jnp.uint8(setup['S'])
    p = jnp.uint8(setup['P'])
    mem = jnp.array(memory, dtype=jnp.uint8)

    # Run one instruction
    new_pc, new_a, new_x, new_y, new_s, new_p, new_mem, cycles, brk_op, halted = \
        step_one_instruction(pc, a, x, y, s, p, mem)

    # Compare registers
    errors = []
    if int(new_pc) != expected['PC']:
        errors.append(f"PC: {int(new_pc)} != {expected['PC']}")
    if int(new_a) != expected['A']:
        errors.append(f"A: {int(new_a)} != {expected['A']}")
    if int(new_x) != expected['X']:
        errors.append(f"X: {int(new_x)} != {expected['X']}")
    if int(new_y) != expected['Y']:
        errors.append(f"Y: {int(new_y)} != {expected['Y']}")
    if int(new_s) != expected['S']:
        errors.append(f"S: {int(new_s)} != {expected['S']}")
    if int(new_p) != expected['P']:
        errors.append(f"P: {int(new_p):08b} != {expected['P']:08b}")
    if int(cycles) != tc['expectedCycles']:
        errors.append(f"cycles: {int(cycles)} != {tc['expectedCycles']}")

    # Compare memory writes
    if 'finalMemory' in tc:
        for addr_str, val in tc['finalMemory'].items():
            addr = int(addr_str)
            if addr < 65536:
                actual = int(new_mem[addr])
                if actual != val:
                    errors.append(f"mem[{addr}]: {actual} != {val}")

    return len(errors) == 0, '; '.join(errors)


def main():
    if not HAS_JAX:
        print("Skipping — JAX not installed")
        return

    tests = load_test_cases()
    print(f"Loaded {len(tests)} test cases")

    passed = 0
    failed = 0
    errors_by_opcode = {}

    for tc in tests:
        ok, err = run_test(tc)
        if ok:
            passed += 1
        else:
            failed += 1
            opcode = tc['setup']['memory'].get(str(tc['setup']['PC']), '?')
            name = tc['name']
            key = f"0x{opcode:02X}" if isinstance(opcode, int) else str(opcode)
            if key not in errors_by_opcode:
                errors_by_opcode[key] = []
            errors_by_opcode[key].append(f"{name}: {err}")

    print(f"\nResults: {passed} passed, {failed} failed out of {len(tests)}")

    if errors_by_opcode:
        print(f"\nFailing opcodes ({len(errors_by_opcode)}):")
        for opcode, errs in sorted(errors_by_opcode.items()):
            print(f"  {opcode}: {len(errs)} failures")
            for e in errs[:3]:
                print(f"    {e}")
            if len(errs) > 3:
                print(f"    ... and {len(errs) - 3} more")


if __name__ == '__main__':
    main()
