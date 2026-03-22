/// Minimal 6502 CPU emulator for 6502life.
/// Cycle-accurate (1 cycle per `run()` call), matching Sfotty's interface.
///
/// This is a simplified implementation covering the official NMOS 6502 opcodes.
/// Undocumented opcodes are treated as crashes (handled by the controller as BRK 0).

use crate::memory::BoardMemory;

/// Processor status flag bits
const FLAG_C: u8 = 0x01;
const FLAG_Z: u8 = 0x02;
const FLAG_I: u8 = 0x04;
const FLAG_D: u8 = 0x08;
const FLAG_B: u8 = 0x10;
const FLAG_U: u8 = 0x20; // unused, always 1
const FLAG_V: u8 = 0x40;
const FLAG_N: u8 = 0x80;

/// Addressing mode
#[derive(Clone, Copy)]
enum AddrMode {
    Implied,
    Accumulator,
    Immediate,
    ZeroPage,
    ZeroPageX,
    ZeroPageY,
    Absolute,
    AbsoluteX,
    AbsoluteY,
    Indirect,
    IndirectX,
    IndirectY,
    Relative,
}

/// CPU state
pub struct Cpu {
    pub pc: u16,
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub s: u8,
    pub p: u8,
    pub crashed: bool,
    /// Cycle counter within current instruction (0 = ready for new instruction)
    pub cycle_counter: u32,
    /// Total cycles remaining for current instruction
    cycles_remaining: u32,
    /// Pending operation to complete when cycles_remaining reaches 0
    pending_op: Option<PendingOp>,
}

/// Stores decoded instruction to execute after cycle counting
struct PendingOp {
    opcode: u8,
    addr: u16,   // effective address (for memory ops)
    val: u8,     // fetched value (for read ops)
}

impl Cpu {
    pub fn new() -> Self {
        Cpu {
            pc: 0,
            a: 0,
            x: 0,
            y: 0,
            s: 0xFD,
            p: FLAG_U | FLAG_I,
            crashed: false,
            cycle_counter: 0,
            cycles_remaining: 0,
            pending_op: None,
        }
    }

    #[inline]
    pub fn flag_i(&self) -> bool {
        self.p & FLAG_I != 0
    }

    #[inline]
    fn set_nz(&mut self, val: u8) {
        self.p = (self.p & !(FLAG_N | FLAG_Z))
            | if val == 0 { FLAG_Z } else { 0 }
            | (val & FLAG_N);
    }

    fn push(&mut self, mem: &mut BoardMemory, val: u8) {
        mem.write(0x0100 | self.s as u16, val);
        self.s = self.s.wrapping_sub(1);
    }

    fn pull(&mut self, mem: &BoardMemory) -> u8 {
        self.s = self.s.wrapping_add(1);
        mem.read(0x0100 | self.s as u16)
    }

    fn read16(&self, mem: &BoardMemory, addr: u16) -> u16 {
        let lo = mem.read(addr) as u16;
        let hi = mem.read(addr.wrapping_add(1)) as u16;
        (hi << 8) | lo
    }

    /// Read 16-bit value with 6502 page-wrap bug (for indirect JMP)
    fn read16_wrap(&self, mem: &BoardMemory, addr: u16) -> u16 {
        let lo = mem.read(addr) as u16;
        let hi_addr = (addr & 0xFF00) | ((addr.wrapping_add(1)) & 0x00FF);
        let hi = mem.read(hi_addr) as u16;
        (hi << 8) | lo
    }

    /// Execute one CPU cycle. Returns true if an instruction boundary was crossed.
    pub fn run(&mut self, mem: &mut BoardMemory) -> bool {
        if self.crashed {
            return false;
        }

        if self.cycle_counter > 0 {
            self.cycle_counter -= 1;
            if self.cycle_counter == 0 {
                // Execute the pending operation
                if let Some(op) = self.pending_op.take() {
                    self.execute(mem, op);
                }
                return true;
            }
            return false;
        }

        // Decode new instruction
        self.decode_and_start(mem);
        if self.cycle_counter == 0 {
            // Single-cycle instruction completed immediately
            return true;
        }
        self.cycle_counter -= 1;
        if self.cycle_counter == 0 {
            if let Some(op) = self.pending_op.take() {
                self.execute(mem, op);
            }
            return true;
        }
        false
    }

    fn decode_and_start(&mut self, mem: &mut BoardMemory) {
        let opcode = mem.read(self.pc);
        let (cycles, addr_mode) = decode_opcode(opcode);

        if cycles == 0 {
            // Undocumented opcode
            self.crashed = true;
            return;
        }

        // Fetch operand based on addressing mode
        let (eff_addr, val, extra_cycle) = self.resolve_address(mem, addr_mode, opcode);

        let total_cycles = cycles as u32 + if extra_cycle { 1 } else { 0 };

        self.pending_op = Some(PendingOp {
            opcode,
            addr: eff_addr,
            val,
        });

        // Advance PC past instruction
        let insn_len = addr_mode_len(addr_mode);
        self.pc = self.pc.wrapping_add(insn_len as u16);

        // We'll count down from total_cycles - 1 (first cycle is this call)
        self.cycle_counter = total_cycles - 1;
    }

    fn resolve_address(
        &self,
        mem: &BoardMemory,
        mode: AddrMode,
        _opcode: u8,
    ) -> (u16, u8, bool) {
        match mode {
            AddrMode::Implied => (0, 0, false),
            AddrMode::Accumulator => (0, self.a, false),
            AddrMode::Immediate => {
                let val = mem.read(self.pc.wrapping_add(1));
                (self.pc.wrapping_add(1), val, false)
            }
            AddrMode::ZeroPage => {
                let addr = mem.read(self.pc.wrapping_add(1)) as u16;
                let val = mem.read(addr);
                (addr, val, false)
            }
            AddrMode::ZeroPageX => {
                let base = mem.read(self.pc.wrapping_add(1));
                let addr = base.wrapping_add(self.x) as u16;
                let val = mem.read(addr);
                (addr, val, false)
            }
            AddrMode::ZeroPageY => {
                let base = mem.read(self.pc.wrapping_add(1));
                let addr = base.wrapping_add(self.y) as u16;
                let val = mem.read(addr);
                (addr, val, false)
            }
            AddrMode::Absolute => {
                let addr = self.read16(mem, self.pc.wrapping_add(1));
                let val = mem.read(addr);
                (addr, val, false)
            }
            AddrMode::AbsoluteX => {
                let base = self.read16(mem, self.pc.wrapping_add(1));
                let addr = base.wrapping_add(self.x as u16);
                let val = mem.read(addr);
                let page_cross = (base & 0xFF00) != (addr & 0xFF00);
                (addr, val, page_cross)
            }
            AddrMode::AbsoluteY => {
                let base = self.read16(mem, self.pc.wrapping_add(1));
                let addr = base.wrapping_add(self.y as u16);
                let val = mem.read(addr);
                let page_cross = (base & 0xFF00) != (addr & 0xFF00);
                (addr, val, page_cross)
            }
            AddrMode::Indirect => {
                let ptr = self.read16(mem, self.pc.wrapping_add(1));
                let addr = self.read16_wrap(mem, ptr);
                (addr, 0, false)
            }
            AddrMode::IndirectX => {
                let base = mem.read(self.pc.wrapping_add(1));
                let ptr = base.wrapping_add(self.x) as u16;
                let addr = self.read16_wrap(mem, ptr);
                let val = mem.read(addr);
                (addr, val, false)
            }
            AddrMode::IndirectY => {
                let ptr = mem.read(self.pc.wrapping_add(1)) as u16;
                let base = self.read16_wrap(mem, ptr);
                let addr = base.wrapping_add(self.y as u16);
                let val = mem.read(addr);
                let page_cross = (base & 0xFF00) != (addr & 0xFF00);
                (addr, val, page_cross)
            }
            AddrMode::Relative => {
                let offset = mem.read(self.pc.wrapping_add(1)) as i8;
                let target = self.pc.wrapping_add(2).wrapping_add(offset as u16);
                (target, 0, false)
            }
        }
    }

    fn execute(&mut self, mem: &mut BoardMemory, op: PendingOp) {
        let PendingOp { opcode, addr, val } = op;

        match opcode {
            // LDA
            0xA9 | 0xA5 | 0xB5 | 0xAD | 0xBD | 0xB9 | 0xA1 | 0xB1 => {
                self.a = val;
                self.set_nz(val);
            }
            // LDX
            0xA2 | 0xA6 | 0xB6 | 0xAE | 0xBE => {
                self.x = val;
                self.set_nz(val);
            }
            // LDY
            0xA0 | 0xA4 | 0xB4 | 0xAC | 0xBC => {
                self.y = val;
                self.set_nz(val);
            }
            // STA
            0x85 | 0x95 | 0x8D | 0x9D | 0x99 | 0x81 | 0x91 => {
                mem.write(addr, self.a);
            }
            // STX
            0x86 | 0x96 | 0x8E => {
                mem.write(addr, self.x);
            }
            // STY
            0x84 | 0x94 | 0x8C => {
                mem.write(addr, self.y);
            }
            // TAX
            0xAA => { self.x = self.a; self.set_nz(self.x); }
            // TAY
            0xA8 => { self.y = self.a; self.set_nz(self.y); }
            // TXA
            0x8A => { self.a = self.x; self.set_nz(self.a); }
            // TYA
            0x98 => { self.a = self.y; self.set_nz(self.a); }
            // TSX
            0xBA => { self.x = self.s; self.set_nz(self.x); }
            // TXS
            0x9A => { self.s = self.x; }
            // PHA
            0x48 => { self.push(mem, self.a); }
            // PHP
            0x08 => { self.push(mem, self.p | FLAG_B | FLAG_U); }
            // PLA
            0x68 => { self.a = self.pull(mem); self.set_nz(self.a); }
            // PLP
            0x28 => { self.p = (self.pull(mem) & !FLAG_B) | FLAG_U; }
            // AND
            0x29 | 0x25 | 0x35 | 0x2D | 0x3D | 0x39 | 0x21 | 0x31 => {
                self.a &= val;
                self.set_nz(self.a);
            }
            // EOR
            0x49 | 0x45 | 0x55 | 0x4D | 0x5D | 0x59 | 0x41 | 0x51 => {
                self.a ^= val;
                self.set_nz(self.a);
            }
            // ORA
            0x09 | 0x05 | 0x15 | 0x0D | 0x1D | 0x19 | 0x01 | 0x11 => {
                self.a |= val;
                self.set_nz(self.a);
            }
            // BIT
            0x24 | 0x2C => {
                self.p = (self.p & !(FLAG_N | FLAG_V | FLAG_Z))
                    | (val & (FLAG_N | FLAG_V))
                    | if self.a & val == 0 { FLAG_Z } else { 0 };
            }
            // ADC
            0x69 | 0x65 | 0x75 | 0x6D | 0x7D | 0x79 | 0x61 | 0x71 => {
                self.adc(val);
            }
            // SBC
            0xE9 | 0xE5 | 0xF5 | 0xED | 0xFD | 0xF9 | 0xE1 | 0xF1 => {
                self.adc(val ^ 0xFF);
            }
            // CMP
            0xC9 | 0xC5 | 0xD5 | 0xCD | 0xDD | 0xD9 | 0xC1 | 0xD1 => {
                self.compare(self.a, val);
            }
            // CPX
            0xE0 | 0xE4 | 0xEC => {
                self.compare(self.x, val);
            }
            // CPY
            0xC0 | 0xC4 | 0xCC => {
                self.compare(self.y, val);
            }
            // INC
            0xE6 | 0xF6 | 0xEE | 0xFE => {
                let r = val.wrapping_add(1);
                mem.write(addr, r);
                self.set_nz(r);
            }
            // INX
            0xE8 => { self.x = self.x.wrapping_add(1); self.set_nz(self.x); }
            // INY
            0xC8 => { self.y = self.y.wrapping_add(1); self.set_nz(self.y); }
            // DEC
            0xC6 | 0xD6 | 0xCE | 0xDE => {
                let r = val.wrapping_sub(1);
                mem.write(addr, r);
                self.set_nz(r);
            }
            // DEX
            0xCA => { self.x = self.x.wrapping_sub(1); self.set_nz(self.x); }
            // DEY
            0x88 => { self.y = self.y.wrapping_sub(1); self.set_nz(self.y); }
            // ASL accumulator
            0x0A => {
                let c = self.a >> 7;
                self.a <<= 1;
                self.p = (self.p & !FLAG_C) | c;
                self.set_nz(self.a);
            }
            // ASL memory
            0x06 | 0x16 | 0x0E | 0x1E => {
                let c = val >> 7;
                let r = val << 1;
                mem.write(addr, r);
                self.p = (self.p & !FLAG_C) | c;
                self.set_nz(r);
            }
            // LSR accumulator
            0x4A => {
                let c = self.a & 1;
                self.a >>= 1;
                self.p = (self.p & !FLAG_C) | c;
                self.set_nz(self.a);
            }
            // LSR memory
            0x46 | 0x56 | 0x4E | 0x5E => {
                let c = val & 1;
                let r = val >> 1;
                mem.write(addr, r);
                self.p = (self.p & !FLAG_C) | c;
                self.set_nz(r);
            }
            // ROL accumulator
            0x2A => {
                let old_c = self.p & FLAG_C;
                let new_c = self.a >> 7;
                self.a = (self.a << 1) | old_c;
                self.p = (self.p & !FLAG_C) | new_c;
                self.set_nz(self.a);
            }
            // ROL memory
            0x26 | 0x36 | 0x2E | 0x3E => {
                let old_c = self.p & FLAG_C;
                let new_c = val >> 7;
                let r = (val << 1) | old_c;
                mem.write(addr, r);
                self.p = (self.p & !FLAG_C) | new_c;
                self.set_nz(r);
            }
            // ROR accumulator
            0x6A => {
                let old_c = self.p & FLAG_C;
                let new_c = self.a & 1;
                self.a = (self.a >> 1) | (old_c << 7);
                self.p = (self.p & !FLAG_C) | new_c;
                self.set_nz(self.a);
            }
            // ROR memory
            0x66 | 0x76 | 0x6E | 0x7E => {
                let old_c = self.p & FLAG_C;
                let new_c = val & 1;
                let r = (val >> 1) | (old_c << 7);
                mem.write(addr, r);
                self.p = (self.p & !FLAG_C) | new_c;
                self.set_nz(r);
            }
            // JMP absolute
            0x4C => { self.pc = addr; }
            // JMP indirect
            0x6C => { self.pc = addr; }
            // JSR
            0x20 => {
                let ret = self.pc.wrapping_sub(1);
                self.push(mem, (ret >> 8) as u8);
                self.push(mem, ret as u8);
                self.pc = addr;
            }
            // RTS
            0x60 => {
                let lo = self.pull(mem) as u16;
                let hi = self.pull(mem) as u16;
                self.pc = ((hi << 8) | lo).wrapping_add(1);
            }
            // RTI
            0x40 => {
                self.p = (self.pull(mem) & !FLAG_B) | FLAG_U;
                let lo = self.pull(mem) as u16;
                let hi = self.pull(mem) as u16;
                self.pc = (hi << 8) | lo;
            }
            // BCC
            0x90 => { if self.p & FLAG_C == 0 { self.pc = addr; } }
            // BCS
            0xB0 => { if self.p & FLAG_C != 0 { self.pc = addr; } }
            // BEQ
            0xF0 => { if self.p & FLAG_Z != 0 { self.pc = addr; } }
            // BMI
            0x30 => { if self.p & FLAG_N != 0 { self.pc = addr; } }
            // BNE
            0xD0 => { if self.p & FLAG_Z == 0 { self.pc = addr; } }
            // BPL
            0x10 => { if self.p & FLAG_N == 0 { self.pc = addr; } }
            // BVC
            0x50 => { if self.p & FLAG_V == 0 { self.pc = addr; } }
            // BVS
            0x70 => { if self.p & FLAG_V != 0 { self.pc = addr; } }
            // CLC
            0x18 => { self.p &= !FLAG_C; }
            // SEC
            0x38 => { self.p |= FLAG_C; }
            // CLD
            0xD8 => { self.p &= !FLAG_D; }
            // SED
            0xF8 => { self.p |= FLAG_D; }
            // CLI
            0x58 => { self.p &= !FLAG_I; }
            // SEI
            0x78 => { self.p |= FLAG_I; }
            // CLV
            0xB8 => { self.p &= !FLAG_V; }
            // NOP
            0xEA => {}
            // BRK — handled by controller, not CPU
            0x00 => {}
            _ => {
                self.crashed = true;
            }
        }
    }

    fn adc(&mut self, val: u8) {
        let carry = (self.p & FLAG_C) as u16;
        let sum = self.a as u16 + val as u16 + carry;
        let result = sum as u8;
        self.p = (self.p & !(FLAG_C | FLAG_V | FLAG_N | FLAG_Z))
            | if sum > 0xFF { FLAG_C } else { 0 }
            | if (!(self.a ^ val) & (self.a ^ result) & 0x80) != 0 { FLAG_V } else { 0 }
            | if result == 0 { FLAG_Z } else { 0 }
            | (result & FLAG_N);
        self.a = result;
    }

    fn compare(&mut self, reg: u8, val: u8) {
        let diff = reg.wrapping_sub(val);
        self.p = (self.p & !(FLAG_C | FLAG_N | FLAG_Z))
            | if reg >= val { FLAG_C } else { 0 }
            | if diff == 0 { FLAG_Z } else { 0 }
            | (diff & FLAG_N);
    }
}

/// Returns (cycles, addressing_mode) for a given opcode.
/// Returns (0, Implied) for undocumented opcodes.
fn decode_opcode(opcode: u8) -> (u8, AddrMode) {
    use AddrMode::*;
    match opcode {
        // BRK
        0x00 => (7, Implied),
        // ORA
        0x01 => (6, IndirectX), 0x05 => (3, ZeroPage), 0x09 => (2, Immediate),
        0x0D => (4, Absolute), 0x11 => (5, IndirectY), 0x15 => (4, ZeroPageX),
        0x19 => (4, AbsoluteY), 0x1D => (4, AbsoluteX),
        // ASL
        0x06 => (5, ZeroPage), 0x0A => (2, Accumulator), 0x0E => (6, Absolute),
        0x16 => (6, ZeroPageX), 0x1E => (7, AbsoluteX),
        // PHP
        0x08 => (3, Implied),
        // BPL
        0x10 => (2, Relative),
        // CLC
        0x18 => (2, Implied),
        // JSR
        0x20 => (6, Absolute),
        // AND
        0x21 => (6, IndirectX), 0x25 => (3, ZeroPage), 0x29 => (2, Immediate),
        0x2D => (4, Absolute), 0x31 => (5, IndirectY), 0x35 => (4, ZeroPageX),
        0x39 => (4, AbsoluteY), 0x3D => (4, AbsoluteX),
        // BIT
        0x24 => (3, ZeroPage), 0x2C => (4, Absolute),
        // ROL
        0x26 => (5, ZeroPage), 0x2A => (2, Accumulator), 0x2E => (6, Absolute),
        0x36 => (6, ZeroPageX), 0x3E => (7, AbsoluteX),
        // PLP
        0x28 => (4, Implied),
        // BMI
        0x30 => (2, Relative),
        // SEC
        0x38 => (2, Implied),
        // RTI
        0x40 => (6, Implied),
        // EOR
        0x41 => (6, IndirectX), 0x45 => (3, ZeroPage), 0x49 => (2, Immediate),
        0x4D => (4, Absolute), 0x51 => (5, IndirectY), 0x55 => (4, ZeroPageX),
        0x59 => (4, AbsoluteY), 0x5D => (4, AbsoluteX),
        // LSR
        0x46 => (5, ZeroPage), 0x4A => (2, Accumulator), 0x4E => (6, Absolute),
        0x56 => (6, ZeroPageX), 0x5E => (7, AbsoluteX),
        // PHA
        0x48 => (3, Implied),
        // JMP absolute
        0x4C => (3, Absolute),
        // BVC
        0x50 => (2, Relative),
        // CLI
        0x58 => (2, Implied),
        // RTS
        0x60 => (6, Implied),
        // ADC
        0x61 => (6, IndirectX), 0x65 => (3, ZeroPage), 0x69 => (2, Immediate),
        0x6D => (4, Absolute), 0x71 => (5, IndirectY), 0x75 => (4, ZeroPageX),
        0x79 => (4, AbsoluteY), 0x7D => (4, AbsoluteX),
        // ROR
        0x66 => (5, ZeroPage), 0x6A => (2, Accumulator), 0x6E => (6, Absolute),
        0x76 => (6, ZeroPageX), 0x7E => (7, AbsoluteX),
        // PLA
        0x68 => (4, Implied),
        // JMP indirect
        0x6C => (5, Indirect),
        // BVS
        0x70 => (2, Relative),
        // SEI
        0x78 => (2, Implied),
        // STA
        0x81 => (6, IndirectX), 0x85 => (3, ZeroPage), 0x8D => (4, Absolute),
        0x91 => (6, IndirectY), 0x95 => (4, ZeroPageX), 0x99 => (5, AbsoluteY),
        0x9D => (5, AbsoluteX),
        // STX
        0x86 => (3, ZeroPage), 0x8E => (4, Absolute), 0x96 => (4, ZeroPageY),
        // STY
        0x84 => (3, ZeroPage), 0x8C => (4, Absolute), 0x94 => (4, ZeroPageX),
        // DEY
        0x88 => (2, Implied),
        // TXA
        0x8A => (2, Implied),
        // BCC
        0x90 => (2, Relative),
        // TYA
        0x98 => (2, Implied),
        // TXS
        0x9A => (2, Implied),
        // LDY
        0xA0 => (2, Immediate), 0xA4 => (3, ZeroPage), 0xAC => (4, Absolute),
        0xB4 => (4, ZeroPageX), 0xBC => (4, AbsoluteX),
        // LDA
        0xA1 => (6, IndirectX), 0xA5 => (3, ZeroPage), 0xA9 => (2, Immediate),
        0xAD => (4, Absolute), 0xB1 => (5, IndirectY), 0xB5 => (4, ZeroPageX),
        0xB9 => (4, AbsoluteY), 0xBD => (4, AbsoluteX),
        // LDX
        0xA2 => (2, Immediate), 0xA6 => (3, ZeroPage), 0xAE => (4, Absolute),
        0xB6 => (4, ZeroPageY), 0xBE => (4, AbsoluteY),
        // TAY
        0xA8 => (2, Implied),
        // TAX
        0xAA => (2, Implied),
        // CLV
        0xB8 => (2, Implied),
        // TSX
        0xBA => (2, Implied),
        // BCS
        0xB0 => (2, Relative),
        // CPY
        0xC0 => (2, Immediate), 0xC4 => (3, ZeroPage), 0xCC => (4, Absolute),
        // CMP
        0xC1 => (6, IndirectX), 0xC5 => (3, ZeroPage), 0xC9 => (2, Immediate),
        0xCD => (4, Absolute), 0xD1 => (5, IndirectY), 0xD5 => (4, ZeroPageX),
        0xD9 => (4, AbsoluteY), 0xDD => (4, AbsoluteX),
        // DEC
        0xC6 => (5, ZeroPage), 0xCE => (6, Absolute), 0xD6 => (6, ZeroPageX),
        0xDE => (7, AbsoluteX),
        // INY
        0xC8 => (2, Implied),
        // DEX
        0xCA => (2, Implied),
        // BNE
        0xD0 => (2, Relative),
        // CLD
        0xD8 => (2, Implied),
        // CPX
        0xE0 => (2, Immediate), 0xE4 => (3, ZeroPage), 0xEC => (4, Absolute),
        // SBC
        0xE1 => (6, IndirectX), 0xE5 => (3, ZeroPage), 0xE9 => (2, Immediate),
        0xED => (4, Absolute), 0xF1 => (5, IndirectY), 0xF5 => (4, ZeroPageX),
        0xF9 => (4, AbsoluteY), 0xFD => (4, AbsoluteX),
        // INC
        0xE6 => (5, ZeroPage), 0xEE => (6, Absolute), 0xF6 => (6, ZeroPageX),
        0xFE => (7, AbsoluteX),
        // INX
        0xE8 => (2, Implied),
        // NOP
        0xEA => (2, Implied),
        // BEQ
        0xF0 => (2, Relative),
        // SED
        0xF8 => (2, Implied),
        // Undocumented
        _ => (0, Implied),
    }
}

fn addr_mode_len(mode: AddrMode) -> u8 {
    match mode {
        AddrMode::Implied | AddrMode::Accumulator => 1,
        AddrMode::Immediate | AddrMode::ZeroPage | AddrMode::ZeroPageX
        | AddrMode::ZeroPageY | AddrMode::IndirectX | AddrMode::IndirectY
        | AddrMode::Relative => 2,
        AddrMode::Absolute | AddrMode::AbsoluteX | AddrMode::AbsoluteY
        | AddrMode::Indirect => 3,
    }
}

/// Check if an opcode is valid (documented NMOS 6502)
pub fn is_valid_opcode(opcode: u8) -> bool {
    decode_opcode(opcode).0 > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cpu_mem() -> (Cpu, BoardMemory) {
        (Cpu::new(), BoardMemory::new(42, 8))
    }

    #[test]
    fn test_lda_immediate() {
        let (mut cpu, mut mem) = make_cpu_mem();
        // LDA #$42
        mem.write(0x0000, 0xA9);
        mem.write(0x0001, 0x42);
        // Run enough cycles
        while cpu.cycle_counter > 0 || cpu.pc == 0 {
            cpu.run(&mut mem);
        }
        assert_eq!(cpu.a, 0x42);
    }

    #[test]
    fn test_sta_zeropage() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x99;
        // STA $10
        mem.write(0x0000, 0x85);
        mem.write(0x0001, 0x10);
        // Run enough cycles for the instruction
        for _ in 0..5 {
            cpu.run(&mut mem);
        }
        assert_eq!(mem.read(0x0010), 0x99);
    }

    #[test]
    fn test_inx() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 0x05;
        // INX
        mem.write(0x0000, 0xE8);
        for _ in 0..3 {
            cpu.run(&mut mem);
        }
        assert_eq!(cpu.x, 0x06);
    }

    #[test]
    fn test_jmp_absolute() {
        let (mut cpu, mut mem) = make_cpu_mem();
        // JMP $0200
        mem.write(0x0000, 0x4C);
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x02);
        // JMP absolute takes 3 cycles. In our model:
        // run() 1: decode + consume 1 cycle (counter=1)
        // run() 2: counter hits 0, execute JMP → PC=0x200
        for _ in 0..2 {
            cpu.run(&mut mem);
        }
        assert_eq!(cpu.pc, 0x0200);
    }

    #[test]
    fn test_valid_opcode_check() {
        assert!(is_valid_opcode(0xA9)); // LDA immediate
        assert!(is_valid_opcode(0xEA)); // NOP
        assert!(is_valid_opcode(0x00)); // BRK
        assert!(!is_valid_opcode(0x02)); // undocumented
        assert!(!is_valid_opcode(0xFF)); // undocumented
    }
}
