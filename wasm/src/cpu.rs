/// Cycle-accurate 6502 CPU emulator matching Sfotty's exact cycle-by-cycle behavior.
///
/// Architecture: phase-based state machine where `run()` advances exactly one cycle,
/// mirroring Sfotty's `operations[cycleCounter++]()` design.
///
/// `cycle_counter` counts UP from 0. After `decode()` resets it to 0, `cycle_counter == 0`
/// indicates an instruction boundary (ready for next instruction).

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

/// The current phase of execution within an instruction.
/// Each variant corresponds to one element in Sfotty's `operations[]` array.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    /// Ready to decode (equivalent to Sfotty's initial `[() => this.decode()]`)
    Decode,
    /// Reset sequence phases 0-6
    Reset(u8),
    /// BRK phases 0-6
    Brk(u8),
    /// RTI phases 0-5
    Rti(u8),
    /// RTS phases 0-5
    Rts(u8),
    /// Push (PHA/PHP) phases 0-2
    Push(u8),
    /// Pull (PLA/PLP) phases 0-3
    Pull(u8),
    /// JSR phases 0-5
    Jsr(u8),
    /// JMP absolute phases 0-2
    JmpAbs(u8),
    /// JMP indirect phases 0-4
    JmpInd(u8),
    /// Branch phases 0-3
    Branch(u8),
    /// Implied 2-cycle (flag set/clear, transfers, NOP, INX, DEX, etc.) phases 0-1
    Implied(u8),
    /// Read instructions (LDA, LDX, LDY, EOR, AND, ORA, ADC, SBC, CMP, CPX, CPY, BIT)
    /// with various addressing modes
    ReadImm(u8),     // 2 cycles: [read_operand+exec, decode]  -> phases 0-1
    ReadZpg(u8),     // 3 cycles: phases 0-2
    ReadAbs(u8),     // 4 cycles: phases 0-3
    ReadZpx(u8),     // 4 cycles: phases 0-3
    ReadZpy(u8),     // 4 cycles: phases 0-3
    ReadAbx(u8),     // 4-5 cycles: phases 0-4
    ReadAby(u8),     // 4-5 cycles: phases 0-4
    ReadInx(u8),     // 6 cycles: phases 0-5
    ReadIny(u8),     // 6-7 cycles: phases 0-6  (really 5-6 but with potential skip)
    /// Store instructions (STA, STX, STY)
    StoreZpg(u8),    // 3 cycles
    StoreAbs(u8),    // 4 cycles
    StoreZpx(u8),    // 3 cycles (Sfotty: zpx store is only 3 cycles!)
    StoreZpy(u8),    // 3 cycles
    StoreAbx(u8),    // 5 cycles
    StoreAby(u8),    // 5 cycles
    StoreInx(u8),    // 6 cycles
    StoreIny(u8),    // 6 cycles
    /// RMW (read-modify-write) instructions: INC, DEC, ASL, LSR, ROL, ROR
    RmwAcc(u8),      // 2 cycles (accumulator mode)
    RmwZpg(u8),      // 5 cycles
    RmwAbs(u8),      // 6 cycles
    RmwZpx(u8),      // 6 cycles
    RmwAbx(u8),      // 7 cycles
}

/// Instruction category for read operations
#[derive(Clone, Copy, Debug, PartialEq)]
enum ReadOp {
    LDA, LDX, LDY, EOR, AND, ORA, ADC, SBC, CMP, CPX, CPY, BIT,
}

/// Instruction category for store operations
#[derive(Clone, Copy, Debug, PartialEq)]
enum StoreOp {
    STA, STX, STY,
}

/// RMW operation type
#[derive(Clone, Copy, Debug, PartialEq)]
enum RmwOp {
    DEC, INC, LSR, ASL, ROR, ROL,
}

/// Branch condition
#[derive(Clone, Copy, Debug, PartialEq)]
enum BranchCond {
    BPL, BMI, BVC, BVS, BCC, BCS, BNE, BEQ,
}

/// Implied operation type
#[derive(Clone, Copy, Debug, PartialEq)]
enum ImpliedOp {
    CLC, SEC, CLI, SEI, CLV, CLD, SED,
    TAY, TYA, TAX, TXA, TSX, TXS,
    DEX, DEY, INX, INY,
    NOP,
}

/// Push operation type
#[derive(Clone, Copy, Debug, PartialEq)]
enum PushOp { PHA, PHP }

/// Pull operation type
#[derive(Clone, Copy, Debug, PartialEq)]
enum PullOp { PLA, PLP }

/// CPU state
pub struct Cpu {
    pub pc: u16,
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub s: u8,
    pub p: u8,
    pub crashed: bool,
    /// Cycle counter within current instruction.
    /// Counts up from 0. Resets to 0 when decode() runs.
    /// cycle_counter == 0 means at instruction boundary (ready to decode).
    pub cycle_counter: u32,
    /// Current execution phase
    phase: Phase,
    /// Temporary storage (matches Sfotty's this.tmp)
    tmp: u32,
    /// Second temporary (matches Sfotty's this.tmp2)
    tmp2: u32,
    /// Decoded instruction info stored alongside phase
    opcode_info: OpcodeInfo,
    /// Reset pending flag (matches Sfotty's resetPending)
    pub reset_pending: bool,
}

/// Stores decoded instruction metadata
#[derive(Clone, Copy, Debug)]
struct OpcodeInfo {
    read_op: Option<ReadOp>,
    store_op: Option<StoreOp>,
    rmw_op: Option<RmwOp>,
    branch_cond: Option<BranchCond>,
    implied_op: Option<ImpliedOp>,
    push_op: Option<PushOp>,
    pull_op: Option<PullOp>,
}

impl Default for OpcodeInfo {
    fn default() -> Self {
        OpcodeInfo {
            read_op: None,
            store_op: None,
            rmw_op: None,
            branch_cond: None,
            implied_op: None,
            push_op: None,
            pull_op: None,
        }
    }
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
            phase: Phase::Decode,
            tmp: 0,
            tmp2: 0,
            opcode_info: OpcodeInfo::default(),
            reset_pending: true,
        }
    }

    /// Reset CPU for a new cell (after interrupt).
    /// Matches Sfotty's post-interrupt reset:
    ///   this.sfotty.crashed = false;
    ///   this.sfotty.cycleCounter = 0;
    ///   this.sfotty.operations = [() => this.sfotty.decode()];
    pub fn reset_for_new_cell(&mut self) {
        self.crashed = false;
        self.cycle_counter = 0;
        self.phase = Phase::Decode;
        self.reset_pending = false;
    }

    #[inline]
    pub fn flag_i(&self) -> bool {
        self.p & FLAG_I != 0
    }

    #[inline]
    fn get_p(&self, brk: bool) -> u8 {
        let mut p = FLAG_U; // bit 5 always set
        if self.p & FLAG_N != 0 { p |= FLAG_N; }
        if self.p & FLAG_V != 0 { p |= FLAG_V; }
        if brk { p |= FLAG_B; }
        if self.p & FLAG_D != 0 { p |= FLAG_D; }
        if self.p & FLAG_I != 0 { p |= FLAG_I; }
        if self.p & FLAG_Z != 0 { p |= FLAG_Z; }
        if self.p & FLAG_C != 0 { p |= FLAG_C; }
        p
    }

    #[inline]
    fn set_p(&mut self, p: u8) {
        // Matches Sfotty's setP: sets N, V, D, I, Z, C from byte. B is not stored.
        self.p = (p & !(FLAG_B)) | FLAG_U;
    }

    #[inline]
    fn set_nz(&mut self, val: u8) {
        // Z = !val, N = val >= 128
        self.p = (self.p & !(FLAG_N | FLAG_Z))
            | if val == 0 { FLAG_Z } else { 0 }
            | (val & FLAG_N);
    }

    /// Execute one CPU cycle. Matches Sfotty's `run()` which does `operations[cycleCounter++]()`.
    ///
    /// After this call, if `cycle_counter == 0`, we are at an instruction boundary
    /// (decode just ran and reset cycle_counter to 0 for the next instruction).
    pub fn run(&mut self, mem: &mut BoardMemory) {
        if self.crashed {
            return;
        }
        // Sfotty: const next = this.operations[this.cycleCounter++]; next();
        // We increment cycle_counter, then execute the current phase.
        // But decode() resets cycle_counter to 0, so we need to handle that.
        let phase = self.phase;
        self.cycle_counter += 1;
        self.execute_phase(mem, phase);
    }

    fn decode(&mut self, mem: &mut BoardMemory) {
        if self.crashed {
            return;
        }

        if self.reset_pending {
            // Sfotty sets operations to 7-element array and resets cycleCounter = 0
            self.phase = Phase::Reset(0);
            self.reset_pending = false;
            self.cycle_counter = 0;
            return;
        }

        // Reset cycle counter (instruction boundary)
        self.cycle_counter = 0;

        let opcode = mem.read(self.pc);
        self.pc = self.pc.wrapping_add(1) & 0xFFFF;

        self.opcode_info = OpcodeInfo::default();

        // Decode opcode into phase + opcode_info, matching Sfotty's switch(decoded.mnemonic)
        match opcode {
            // BRK
            0x00 => {
                self.phase = Phase::Brk(0);
                return;
            }
            // RTI
            0x40 => {
                self.phase = Phase::Rti(0);
                return;
            }
            // RTS
            0x60 => {
                self.phase = Phase::Rts(0);
                return;
            }
            // PHA
            0x48 => {
                self.opcode_info.push_op = Some(PushOp::PHA);
                self.phase = Phase::Push(0);
                return;
            }
            // PHP
            0x08 => {
                self.opcode_info.push_op = Some(PushOp::PHP);
                self.phase = Phase::Push(0);
                return;
            }
            // PLA
            0x68 => {
                self.opcode_info.pull_op = Some(PullOp::PLA);
                self.phase = Phase::Pull(0);
                return;
            }
            // PLP
            0x28 => {
                self.opcode_info.pull_op = Some(PullOp::PLP);
                self.phase = Phase::Pull(0);
                return;
            }
            // JSR
            0x20 => {
                self.phase = Phase::Jsr(0);
                return;
            }
            // JMP absolute
            0x4C => {
                self.phase = Phase::JmpAbs(0);
                return;
            }
            // JMP indirect
            0x6C => {
                self.phase = Phase::JmpInd(0);
                return;
            }
            // Branches
            0x10 => { self.opcode_info.branch_cond = Some(BranchCond::BPL); self.phase = Phase::Branch(0); return; }
            0x30 => { self.opcode_info.branch_cond = Some(BranchCond::BMI); self.phase = Phase::Branch(0); return; }
            0x50 => { self.opcode_info.branch_cond = Some(BranchCond::BVC); self.phase = Phase::Branch(0); return; }
            0x70 => { self.opcode_info.branch_cond = Some(BranchCond::BVS); self.phase = Phase::Branch(0); return; }
            0x90 => { self.opcode_info.branch_cond = Some(BranchCond::BCC); self.phase = Phase::Branch(0); return; }
            0xB0 => { self.opcode_info.branch_cond = Some(BranchCond::BCS); self.phase = Phase::Branch(0); return; }
            0xD0 => { self.opcode_info.branch_cond = Some(BranchCond::BNE); self.phase = Phase::Branch(0); return; }
            0xF0 => { self.opcode_info.branch_cond = Some(BranchCond::BEQ); self.phase = Phase::Branch(0); return; }
            // Implied instructions (2 cycles: dummy read + decode)
            0x18 => { self.opcode_info.implied_op = Some(ImpliedOp::CLC); self.phase = Phase::Implied(0); return; }
            0x38 => { self.opcode_info.implied_op = Some(ImpliedOp::SEC); self.phase = Phase::Implied(0); return; }
            0x58 => { self.opcode_info.implied_op = Some(ImpliedOp::CLI); self.phase = Phase::Implied(0); return; }
            0x78 => { self.opcode_info.implied_op = Some(ImpliedOp::SEI); self.phase = Phase::Implied(0); return; }
            0xB8 => { self.opcode_info.implied_op = Some(ImpliedOp::CLV); self.phase = Phase::Implied(0); return; }
            0xD8 => { self.opcode_info.implied_op = Some(ImpliedOp::CLD); self.phase = Phase::Implied(0); return; }
            0xF8 => { self.opcode_info.implied_op = Some(ImpliedOp::SED); self.phase = Phase::Implied(0); return; }
            0xA8 => { self.opcode_info.implied_op = Some(ImpliedOp::TAY); self.phase = Phase::Implied(0); return; }
            0x98 => { self.opcode_info.implied_op = Some(ImpliedOp::TYA); self.phase = Phase::Implied(0); return; }
            0xAA => { self.opcode_info.implied_op = Some(ImpliedOp::TAX); self.phase = Phase::Implied(0); return; }
            0x8A => { self.opcode_info.implied_op = Some(ImpliedOp::TXA); self.phase = Phase::Implied(0); return; }
            0xBA => { self.opcode_info.implied_op = Some(ImpliedOp::TSX); self.phase = Phase::Implied(0); return; }
            0x9A => { self.opcode_info.implied_op = Some(ImpliedOp::TXS); self.phase = Phase::Implied(0); return; }
            0xCA => { self.opcode_info.implied_op = Some(ImpliedOp::DEX); self.phase = Phase::Implied(0); return; }
            0x88 => { self.opcode_info.implied_op = Some(ImpliedOp::DEY); self.phase = Phase::Implied(0); return; }
            0xE8 => { self.opcode_info.implied_op = Some(ImpliedOp::INX); self.phase = Phase::Implied(0); return; }
            0xC8 => { self.opcode_info.implied_op = Some(ImpliedOp::INY); self.phase = Phase::Implied(0); return; }
            0xEA => { self.opcode_info.implied_op = Some(ImpliedOp::NOP); self.phase = Phase::Implied(0); return; }

            // Read instructions: LDA, LDX, LDY, EOR, AND, ORA, ADC, SBC, CMP, CPX, CPY, BIT
            // LDA
            0xA9 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadImm(0); return; }
            0xA5 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadZpg(0); return; }
            0xAD => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadAbs(0); return; }
            0xB5 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadZpx(0); return; }
            0xBD => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadAbx(0); return; }
            0xB9 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadAby(0); return; }
            0xA1 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadInx(0); return; }
            0xB1 => { self.opcode_info.read_op = Some(ReadOp::LDA); self.phase = Phase::ReadIny(0); return; }
            // LDX
            0xA2 => { self.opcode_info.read_op = Some(ReadOp::LDX); self.phase = Phase::ReadImm(0); return; }
            0xA6 => { self.opcode_info.read_op = Some(ReadOp::LDX); self.phase = Phase::ReadZpg(0); return; }
            0xAE => { self.opcode_info.read_op = Some(ReadOp::LDX); self.phase = Phase::ReadAbs(0); return; }
            0xB6 => { self.opcode_info.read_op = Some(ReadOp::LDX); self.phase = Phase::ReadZpy(0); return; }
            0xBE => { self.opcode_info.read_op = Some(ReadOp::LDX); self.phase = Phase::ReadAby(0); return; }
            // LDY
            0xA0 => { self.opcode_info.read_op = Some(ReadOp::LDY); self.phase = Phase::ReadImm(0); return; }
            0xA4 => { self.opcode_info.read_op = Some(ReadOp::LDY); self.phase = Phase::ReadZpg(0); return; }
            0xAC => { self.opcode_info.read_op = Some(ReadOp::LDY); self.phase = Phase::ReadAbs(0); return; }
            0xB4 => { self.opcode_info.read_op = Some(ReadOp::LDY); self.phase = Phase::ReadZpx(0); return; }
            0xBC => { self.opcode_info.read_op = Some(ReadOp::LDY); self.phase = Phase::ReadAbx(0); return; }
            // EOR
            0x49 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadImm(0); return; }
            0x45 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadZpg(0); return; }
            0x4D => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadAbs(0); return; }
            0x55 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadZpx(0); return; }
            0x5D => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadAbx(0); return; }
            0x59 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadAby(0); return; }
            0x41 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadInx(0); return; }
            0x51 => { self.opcode_info.read_op = Some(ReadOp::EOR); self.phase = Phase::ReadIny(0); return; }
            // AND
            0x29 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadImm(0); return; }
            0x25 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadZpg(0); return; }
            0x2D => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadAbs(0); return; }
            0x35 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadZpx(0); return; }
            0x3D => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadAbx(0); return; }
            0x39 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadAby(0); return; }
            0x21 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadInx(0); return; }
            0x31 => { self.opcode_info.read_op = Some(ReadOp::AND); self.phase = Phase::ReadIny(0); return; }
            // ORA
            0x09 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadImm(0); return; }
            0x05 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadZpg(0); return; }
            0x0D => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadAbs(0); return; }
            0x15 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadZpx(0); return; }
            0x1D => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadAbx(0); return; }
            0x19 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadAby(0); return; }
            0x01 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadInx(0); return; }
            0x11 => { self.opcode_info.read_op = Some(ReadOp::ORA); self.phase = Phase::ReadIny(0); return; }
            // ADC
            0x69 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadImm(0); return; }
            0x65 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadZpg(0); return; }
            0x6D => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadAbs(0); return; }
            0x75 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadZpx(0); return; }
            0x7D => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadAbx(0); return; }
            0x79 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadAby(0); return; }
            0x61 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadInx(0); return; }
            0x71 => { self.opcode_info.read_op = Some(ReadOp::ADC); self.phase = Phase::ReadIny(0); return; }
            // SBC
            0xE9 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadImm(0); return; }
            0xE5 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadZpg(0); return; }
            0xED => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadAbs(0); return; }
            0xF5 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadZpx(0); return; }
            0xFD => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadAbx(0); return; }
            0xF9 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadAby(0); return; }
            0xE1 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadInx(0); return; }
            0xF1 => { self.opcode_info.read_op = Some(ReadOp::SBC); self.phase = Phase::ReadIny(0); return; }
            // CMP
            0xC9 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadImm(0); return; }
            0xC5 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadZpg(0); return; }
            0xCD => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadAbs(0); return; }
            0xD5 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadZpx(0); return; }
            0xDD => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadAbx(0); return; }
            0xD9 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadAby(0); return; }
            0xC1 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadInx(0); return; }
            0xD1 => { self.opcode_info.read_op = Some(ReadOp::CMP); self.phase = Phase::ReadIny(0); return; }
            // CPX
            0xE0 => { self.opcode_info.read_op = Some(ReadOp::CPX); self.phase = Phase::ReadImm(0); return; }
            0xE4 => { self.opcode_info.read_op = Some(ReadOp::CPX); self.phase = Phase::ReadZpg(0); return; }
            0xEC => { self.opcode_info.read_op = Some(ReadOp::CPX); self.phase = Phase::ReadAbs(0); return; }
            // CPY
            0xC0 => { self.opcode_info.read_op = Some(ReadOp::CPY); self.phase = Phase::ReadImm(0); return; }
            0xC4 => { self.opcode_info.read_op = Some(ReadOp::CPY); self.phase = Phase::ReadZpg(0); return; }
            0xCC => { self.opcode_info.read_op = Some(ReadOp::CPY); self.phase = Phase::ReadAbs(0); return; }
            // BIT
            0x24 => { self.opcode_info.read_op = Some(ReadOp::BIT); self.phase = Phase::ReadZpg(0); return; }
            0x2C => { self.opcode_info.read_op = Some(ReadOp::BIT); self.phase = Phase::ReadAbs(0); return; }

            // Store instructions: STA, STX, STY
            // STA
            0x85 => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreZpg(0); return; }
            0x8D => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreAbs(0); return; }
            0x95 => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreZpx(0); return; }
            0x9D => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreAbx(0); return; }
            0x99 => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreAby(0); return; }
            0x81 => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreInx(0); return; }
            0x91 => { self.opcode_info.store_op = Some(StoreOp::STA); self.phase = Phase::StoreIny(0); return; }
            // STX
            0x86 => { self.opcode_info.store_op = Some(StoreOp::STX); self.phase = Phase::StoreZpg(0); return; }
            0x8E => { self.opcode_info.store_op = Some(StoreOp::STX); self.phase = Phase::StoreAbs(0); return; }
            0x96 => { self.opcode_info.store_op = Some(StoreOp::STX); self.phase = Phase::StoreZpy(0); return; }
            // STY
            0x84 => { self.opcode_info.store_op = Some(StoreOp::STY); self.phase = Phase::StoreZpg(0); return; }
            0x8C => { self.opcode_info.store_op = Some(StoreOp::STY); self.phase = Phase::StoreAbs(0); return; }
            0x94 => { self.opcode_info.store_op = Some(StoreOp::STY); self.phase = Phase::StoreZpx(0); return; }

            // RMW instructions: ASL, LSR, ROL, ROR, INC, DEC
            // ASL
            0x0A => { self.opcode_info.rmw_op = Some(RmwOp::ASL); self.phase = Phase::RmwAcc(0); return; }
            0x06 => { self.opcode_info.rmw_op = Some(RmwOp::ASL); self.phase = Phase::RmwZpg(0); return; }
            0x0E => { self.opcode_info.rmw_op = Some(RmwOp::ASL); self.phase = Phase::RmwAbs(0); return; }
            0x16 => { self.opcode_info.rmw_op = Some(RmwOp::ASL); self.phase = Phase::RmwZpx(0); return; }
            0x1E => { self.opcode_info.rmw_op = Some(RmwOp::ASL); self.phase = Phase::RmwAbx(0); return; }
            // LSR
            0x4A => { self.opcode_info.rmw_op = Some(RmwOp::LSR); self.phase = Phase::RmwAcc(0); return; }
            0x46 => { self.opcode_info.rmw_op = Some(RmwOp::LSR); self.phase = Phase::RmwZpg(0); return; }
            0x4E => { self.opcode_info.rmw_op = Some(RmwOp::LSR); self.phase = Phase::RmwAbs(0); return; }
            0x56 => { self.opcode_info.rmw_op = Some(RmwOp::LSR); self.phase = Phase::RmwZpx(0); return; }
            0x5E => { self.opcode_info.rmw_op = Some(RmwOp::LSR); self.phase = Phase::RmwAbx(0); return; }
            // ROL
            0x2A => { self.opcode_info.rmw_op = Some(RmwOp::ROL); self.phase = Phase::RmwAcc(0); return; }
            0x26 => { self.opcode_info.rmw_op = Some(RmwOp::ROL); self.phase = Phase::RmwZpg(0); return; }
            0x2E => { self.opcode_info.rmw_op = Some(RmwOp::ROL); self.phase = Phase::RmwAbs(0); return; }
            0x36 => { self.opcode_info.rmw_op = Some(RmwOp::ROL); self.phase = Phase::RmwZpx(0); return; }
            0x3E => { self.opcode_info.rmw_op = Some(RmwOp::ROL); self.phase = Phase::RmwAbx(0); return; }
            // ROR
            0x6A => { self.opcode_info.rmw_op = Some(RmwOp::ROR); self.phase = Phase::RmwAcc(0); return; }
            0x66 => { self.opcode_info.rmw_op = Some(RmwOp::ROR); self.phase = Phase::RmwZpg(0); return; }
            0x6E => { self.opcode_info.rmw_op = Some(RmwOp::ROR); self.phase = Phase::RmwAbs(0); return; }
            0x76 => { self.opcode_info.rmw_op = Some(RmwOp::ROR); self.phase = Phase::RmwZpx(0); return; }
            0x7E => { self.opcode_info.rmw_op = Some(RmwOp::ROR); self.phase = Phase::RmwAbx(0); return; }
            // INC
            0xE6 => { self.opcode_info.rmw_op = Some(RmwOp::INC); self.phase = Phase::RmwZpg(0); return; }
            0xEE => { self.opcode_info.rmw_op = Some(RmwOp::INC); self.phase = Phase::RmwAbs(0); return; }
            0xF6 => { self.opcode_info.rmw_op = Some(RmwOp::INC); self.phase = Phase::RmwZpx(0); return; }
            0xFE => { self.opcode_info.rmw_op = Some(RmwOp::INC); self.phase = Phase::RmwAbx(0); return; }
            // DEC
            0xC6 => { self.opcode_info.rmw_op = Some(RmwOp::DEC); self.phase = Phase::RmwZpg(0); return; }
            0xCE => { self.opcode_info.rmw_op = Some(RmwOp::DEC); self.phase = Phase::RmwAbs(0); return; }
            0xD6 => { self.opcode_info.rmw_op = Some(RmwOp::DEC); self.phase = Phase::RmwZpx(0); return; }
            0xDE => { self.opcode_info.rmw_op = Some(RmwOp::DEC); self.phase = Phase::RmwAbx(0); return; }

            // Undocumented opcode
            _ => {
                self.crashed = true;
                self.pc = self.pc.wrapping_sub(1); // Sfotty: this.PC--
                return;
            }
        }
    }

    fn execute_phase(&mut self, mem: &mut BoardMemory, phase: Phase) {
        match phase {
            Phase::Decode => {
                self.decode(mem);
            }

            // ========== RESET (7 cycles) ==========
            // Sfotty reset operations[0..6]:
            // 0: read(PC)
            // 1: read(S+256); S--
            // 2: read(S+256); S--
            // 3: write(S+256, getP()); S--
            // 4: tmp = read(0xFFFC)
            // 5: PC = read(0xFFFD)*256 + tmp
            // 6: decode()
            Phase::Reset(0) => {
                mem.read(self.pc);
                self.phase = Phase::Reset(1);
            }
            Phase::Reset(1) => {
                mem.read(0x100 + self.s as u16);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Reset(2);
            }
            Phase::Reset(2) => {
                mem.read(0x100 + self.s as u16);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Reset(3);
            }
            Phase::Reset(3) => {
                let p = self.get_p(false);
                mem.write(0x100 + self.s as u16, p);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Reset(4);
            }
            Phase::Reset(4) => {
                self.tmp = mem.read(0xFFFC) as u32;
                self.phase = Phase::Reset(5);
            }
            Phase::Reset(5) => {
                self.pc = (mem.read(0xFFFD) as u16) * 256 + self.tmp as u16;
                self.phase = Phase::Reset(6);
            }
            Phase::Reset(6) => {
                self.decode(mem);
            }

            // ========== BRK (7 cycles) ==========
            // 0: read(PC)  (PC already advanced past opcode)
            // 1: write(S+256, PC>>8); S--
            // 2: write(S+256, PC&255); S--
            // 3: write(S+256, getP(true)); S--
            // 4: tmp = read(0xFFFE)
            // 5: PC = read(0xFFFF)*256 + tmp
            // 6: decode()
            Phase::Brk(0) => {
                mem.read(self.pc);
                self.phase = Phase::Brk(1);
            }
            Phase::Brk(1) => {
                mem.write(0x100 + self.s as u16, (self.pc >> 8) as u8);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Brk(2);
            }
            Phase::Brk(2) => {
                mem.write(0x100 + self.s as u16, (self.pc & 0xFF) as u8);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Brk(3);
            }
            Phase::Brk(3) => {
                let p = self.get_p(true);
                mem.write(0x100 + self.s as u16, p);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Brk(4);
            }
            Phase::Brk(4) => {
                self.tmp = mem.read(0xFFFE) as u32;
                self.phase = Phase::Brk(5);
            }
            Phase::Brk(5) => {
                self.pc = (mem.read(0xFFFF) as u16) * 256 + self.tmp as u16;
                self.phase = Phase::Brk(6);
            }
            Phase::Brk(6) => {
                self.decode(mem);
            }

            // ========== RTI (6 cycles) ==========
            // 0: read(PC) dummy
            // 1: read(S+256); S++
            // 2: setP(read(S+256)); S++
            // 3: PC = (PC & 0xFF00) | read(S+256); S++
            // 4: PC = (PC & 0xFF) + read(S+256)*256
            // 5: decode()
            Phase::Rti(0) => {
                mem.read(self.pc);
                self.phase = Phase::Rti(1);
            }
            Phase::Rti(1) => {
                mem.read(0x100 + self.s as u16);
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Rti(2);
            }
            Phase::Rti(2) => {
                let val = mem.read(0x100 + self.s as u16);
                self.set_p(val);
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Rti(3);
            }
            Phase::Rti(3) => {
                let lo = mem.read(0x100 + self.s as u16);
                self.pc = (self.pc & 0xFF00) | lo as u16;
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Rti(4);
            }
            Phase::Rti(4) => {
                let hi = mem.read(0x100 + self.s as u16);
                self.pc = (self.pc & 0x00FF) + (hi as u16) * 256;
                self.phase = Phase::Rti(5);
            }
            Phase::Rti(5) => {
                self.decode(mem);
            }

            // ========== RTS (6 cycles) ==========
            // 0: read(PC) dummy
            // 1: read(S+256); S++
            // 2: PC = (PC & 0xFF00) | read(S+256); S++
            // 3: PC = (PC & 0xFF) + read(S+256)*256
            // 4: PC++; read(PC)
            // 5: decode()
            Phase::Rts(0) => {
                mem.read(self.pc);
                self.phase = Phase::Rts(1);
            }
            Phase::Rts(1) => {
                mem.read(0x100 + self.s as u16);
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Rts(2);
            }
            Phase::Rts(2) => {
                let lo = mem.read(0x100 + self.s as u16);
                self.pc = (self.pc & 0xFF00) | lo as u16;
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Rts(3);
            }
            Phase::Rts(3) => {
                let hi = mem.read(0x100 + self.s as u16);
                self.pc = (self.pc & 0x00FF) + (hi as u16) * 256;
                self.phase = Phase::Rts(4);
            }
            Phase::Rts(4) => {
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                mem.read(self.pc);
                self.phase = Phase::Rts(5);
            }
            Phase::Rts(5) => {
                self.decode(mem);
            }

            // ========== PUSH (PHA/PHP) - 3 cycles ==========
            // 0: read(PC) dummy
            // 1: write(S+256, value); S--
            // 2: decode()
            Phase::Push(0) => {
                mem.read(self.pc);
                self.phase = Phase::Push(1);
            }
            Phase::Push(1) => {
                let val = match self.opcode_info.push_op.unwrap() {
                    PushOp::PHA => self.a,
                    PushOp::PHP => self.get_p(true),
                };
                mem.write(0x100 + self.s as u16, val);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Push(2);
            }
            Phase::Push(2) => {
                self.decode(mem);
            }

            // ========== PULL (PLA/PLP) - 4 cycles ==========
            // 0: read(PC) dummy
            // 1: read(S+256); S++
            // 2: op = read(S+256); apply
            // 3: decode()
            Phase::Pull(0) => {
                mem.read(self.pc);
                self.phase = Phase::Pull(1);
            }
            Phase::Pull(1) => {
                mem.read(0x100 + self.s as u16);
                self.s = self.s.wrapping_add(1);
                self.phase = Phase::Pull(2);
            }
            Phase::Pull(2) => {
                let val = mem.read(0x100 + self.s as u16);
                match self.opcode_info.pull_op.unwrap() {
                    PullOp::PLA => {
                        self.a = val;
                        // Sfotty: Z = !op; N = op >= 128
                        self.p = (self.p & !(FLAG_Z | FLAG_N))
                            | if val == 0 { FLAG_Z } else { 0 }
                            | if val >= 128 { FLAG_N } else { 0 };
                    }
                    PullOp::PLP => {
                        self.set_p(val);
                    }
                }
                self.phase = Phase::Pull(3);
            }
            Phase::Pull(3) => {
                self.decode(mem);
            }

            // ========== JSR - 6 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(S+256)   (dummy)
            // 2: write(S+256, PC>>8); S--
            // 3: write(S+256, PC&255); S--
            // 4: PC = read(PC)*256 + tmp
            // 5: decode()
            Phase::Jsr(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::Jsr(1);
            }
            Phase::Jsr(1) => {
                mem.read(0x100 + self.s as u16);
                self.phase = Phase::Jsr(2);
            }
            Phase::Jsr(2) => {
                mem.write(0x100 + self.s as u16, (self.pc >> 8) as u8);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Jsr(3);
            }
            Phase::Jsr(3) => {
                mem.write(0x100 + self.s as u16, (self.pc & 0xFF) as u8);
                self.s = self.s.wrapping_sub(1);
                self.phase = Phase::Jsr(4);
            }
            Phase::Jsr(4) => {
                self.pc = (mem.read(self.pc) as u16) * 256 + self.tmp as u16;
                self.phase = Phase::Jsr(5);
            }
            Phase::Jsr(5) => {
                self.decode(mem);
            }

            // ========== JMP absolute - 3 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: PC = read(PC)*256 + tmp
            // 2: decode()
            Phase::JmpAbs(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::JmpAbs(1);
            }
            Phase::JmpAbs(1) => {
                self.pc = (mem.read(self.pc) as u16) * 256 + self.tmp as u16;
                self.phase = Phase::JmpAbs(2);
            }
            Phase::JmpAbs(2) => {
                self.decode(mem);
            }

            // ========== JMP indirect - 5 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256
            // 2: tmp2 = read(tmp)
            // 3: lo = (tmp+1)&255; hi = tmp&0xFF00; PC = read(hi|lo)*256 + tmp2
            // 4: decode()
            Phase::JmpInd(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::JmpInd(1);
            }
            Phase::JmpInd(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.phase = Phase::JmpInd(2);
            }
            Phase::JmpInd(2) => {
                self.tmp2 = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::JmpInd(3);
            }
            Phase::JmpInd(3) => {
                // 6502 page-wrap bug
                let lo = (self.tmp.wrapping_add(1)) & 0xFF;
                let hi = self.tmp & 0xFF00;
                self.pc = (mem.read((hi | lo) as u16) as u16) * 256 + self.tmp2 as u16;
                self.phase = Phase::JmpInd(4);
            }
            Phase::JmpInd(4) => {
                self.decode(mem);
            }

            // ========== BRANCH - 2/3/4 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: check condition. If not taken: decode(). If taken: read(PC); compute target.
            //    If same page: PC = target; cycleCounter++ (skip phase 2, go to decode).
            //    If different page: PC = (PC & 0xFF00) | (target & 0xFF)
            // 2: PC = target (the full address)
            // 3: decode()
            Phase::Branch(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::Branch(1);
            }
            Phase::Branch(1) => {
                let taken = match self.opcode_info.branch_cond.unwrap() {
                    BranchCond::BPL => self.p & FLAG_N == 0,
                    BranchCond::BMI => self.p & FLAG_N != 0,
                    BranchCond::BVC => self.p & FLAG_V == 0,
                    BranchCond::BVS => self.p & FLAG_V != 0,
                    BranchCond::BCC => self.p & FLAG_C == 0,
                    BranchCond::BCS => self.p & FLAG_C != 0,
                    BranchCond::BNE => self.p & FLAG_Z == 0,
                    BranchCond::BEQ => self.p & FLAG_Z != 0,
                };
                if !taken {
                    self.decode(mem);
                    return;
                }
                mem.read(self.pc);
                // Sfotty: this.tmp = this.PC + (this.tmp >= 128 ? this.tmp - 256 : this.tmp)
                let offset = if self.tmp >= 128 {
                    self.tmp as i32 - 256
                } else {
                    self.tmp as i32
                };
                self.tmp = (self.pc as i32 + offset) as u32;
                // Check same page
                if (self.tmp >> 8) == (self.pc as u32 >> 8) {
                    // Same page: set PC directly, skip phase 2 (go to decode)
                    self.pc = self.tmp as u16;
                    self.phase = Phase::Branch(3); // skip phase 2
                } else {
                    // Cross-page: set PC partially, phase 2 will fix it
                    self.pc = (self.pc & 0xFF00) | (self.tmp as u16 & 0x00FF);
                    self.phase = Phase::Branch(2);
                }
            }
            Phase::Branch(2) => {
                // Only executes on page cross: fix PC to full target
                self.pc = self.tmp as u16;
                self.phase = Phase::Branch(3);
            }
            Phase::Branch(3) => {
                self.decode(mem);
            }

            // ========== IMPLIED 2-cycle instructions ==========
            // 0: read(PC) dummy; execute operation
            // 1: decode()
            Phase::Implied(0) => {
                mem.read(self.pc);
                match self.opcode_info.implied_op.unwrap() {
                    ImpliedOp::CLC => { self.p &= !FLAG_C; }
                    ImpliedOp::SEC => { self.p |= FLAG_C; }
                    ImpliedOp::CLI => { self.p &= !FLAG_I; }
                    ImpliedOp::SEI => { self.p |= FLAG_I; }
                    ImpliedOp::CLV => { self.p &= !FLAG_V; }
                    ImpliedOp::CLD => { self.p &= !FLAG_D; }
                    ImpliedOp::SED => { self.p |= FLAG_D; }
                    ImpliedOp::TAY => {
                        self.y = self.a;
                        self.set_nz(self.y);
                    }
                    ImpliedOp::TYA => {
                        self.a = self.y;
                        self.set_nz(self.a);
                    }
                    ImpliedOp::TAX => {
                        self.x = self.a;
                        self.set_nz(self.x);
                    }
                    ImpliedOp::TXA => {
                        self.a = self.x;
                        self.set_nz(self.a);
                    }
                    ImpliedOp::TSX => {
                        // Sfotty bug: TSX does NOT set N/Z flags
                        self.x = self.s;
                    }
                    ImpliedOp::TXS => {
                        self.s = self.x;
                    }
                    ImpliedOp::DEX => {
                        self.x = self.x.wrapping_sub(1);
                        self.set_nz(self.x);
                    }
                    ImpliedOp::DEY => {
                        self.y = self.y.wrapping_sub(1);
                        self.set_nz(self.y);
                    }
                    ImpliedOp::INX => {
                        self.x = self.x.wrapping_add(1);
                        self.set_nz(self.x);
                    }
                    ImpliedOp::INY => {
                        self.y = self.y.wrapping_add(1);
                        self.set_nz(self.y);
                    }
                    ImpliedOp::NOP => { /* NOP: just the dummy read above */ }
                }
                self.phase = Phase::Implied(1);
            }
            Phase::Implied(1) => {
                self.decode(mem);
            }

            // ========== READ IMMEDIATE - 2 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: exec_read_op(); decode()
            Phase::ReadImm(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadImm(1);
            }
            Phase::ReadImm(1) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ZERO PAGE - 3 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp = read(tmp)
            // 2: exec; decode()
            Phase::ReadZpg(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadZpg(1);
            }
            Phase::ReadZpg(1) => {
                self.tmp = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::ReadZpg(2);
            }
            Phase::ReadZpg(2) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ABSOLUTE - 4 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: tmp = read(tmp)
            // 3: exec; decode()
            Phase::ReadAbs(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAbs(1);
            }
            Phase::ReadAbs(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAbs(2);
            }
            Phase::ReadAbs(2) => {
                self.tmp = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::ReadAbs(3);
            }
            Phase::ReadAbs(3) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ZERO PAGE,X - 4 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(tmp) dummy
            // 2: tmp = read((tmp+X) & 0xFF)
            // 3: exec; decode()
            Phase::ReadZpx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadZpx(1);
            }
            Phase::ReadZpx(1) => {
                mem.read(self.tmp as u16);
                self.phase = Phase::ReadZpx(2);
            }
            Phase::ReadZpx(2) => {
                self.tmp = mem.read(((self.tmp + self.x as u32) & 0xFF) as u16) as u32;
                self.phase = Phase::ReadZpx(3);
            }
            Phase::ReadZpx(3) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ZERO PAGE,Y - 4 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(tmp) dummy
            // 2: tmp = read((tmp+Y) & 0xFF)
            // 3: exec; decode()
            Phase::ReadZpy(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadZpy(1);
            }
            Phase::ReadZpy(1) => {
                mem.read(self.tmp as u16);
                self.phase = Phase::ReadZpy(2);
            }
            Phase::ReadZpy(2) => {
                self.tmp = mem.read(((self.tmp + self.y as u32) & 0xFF) as u16) as u32;
                self.phase = Phase::ReadZpy(3);
            }
            Phase::ReadZpy(3) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ABSOLUTE,X - 4/5 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: lo = tmp & 0xFF; hi = tmp & 0xFF00; lo += X;
            //    if lo < 255: tmp = read(tmp+X); cycleCounter++ (skip phase 3)
            //    else: read(hi | (lo & 0xFF))   (dummy read at wrong page)
            // 3: tmp = read(tmp+X)
            // 4: exec; decode()
            Phase::ReadAbx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAbx(1);
            }
            Phase::ReadAbx(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAbx(2);
            }
            Phase::ReadAbx(2) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.x as u32;
                if new_lo < 255 {
                    // No page cross — read from correct address, skip phase 3
                    self.tmp = mem.read((self.tmp + self.x as u32) as u16) as u32;
                    self.phase = Phase::ReadAbx(4); // skip phase 3
                } else {
                    // Page cross — dummy read at wrong address
                    mem.read((hi | (new_lo & 0xFF)) as u16);
                    self.phase = Phase::ReadAbx(3);
                }
            }
            Phase::ReadAbx(3) => {
                // Only executes on page cross
                self.tmp = mem.read((self.tmp.wrapping_add(self.x as u32)) as u16) as u32;
                self.phase = Phase::ReadAbx(4);
            }
            Phase::ReadAbx(4) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ ABSOLUTE,Y - 4/5 cycles ==========
            // Same pattern as AbsX but with Y
            Phase::ReadAby(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAby(1);
            }
            Phase::ReadAby(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadAby(2);
            }
            Phase::ReadAby(2) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.y as u32;
                if new_lo < 255 {
                    self.tmp = mem.read((self.tmp + self.y as u32) as u16) as u32;
                    self.phase = Phase::ReadAby(4); // skip phase 3
                } else {
                    mem.read((hi | (new_lo & 0xFF)) as u16);
                    self.phase = Phase::ReadAby(3);
                }
            }
            Phase::ReadAby(3) => {
                self.tmp = mem.read((self.tmp.wrapping_add(self.y as u32)) as u16) as u32;
                self.phase = Phase::ReadAby(4);
            }
            Phase::ReadAby(4) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ (INDIRECT,X) - 6 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(tmp); tmp2 = (tmp+X) & 0xFF
            // 2: tmp = read(tmp2++ & 0xFF)
            // 3: tmp += read(tmp2 & 0xFF)*256
            // 4: tmp = read(tmp)
            // 5: exec; decode()
            Phase::ReadInx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadInx(1);
            }
            Phase::ReadInx(1) => {
                mem.read(self.tmp as u16);
                self.tmp2 = (self.tmp + self.x as u32) & 0xFF;
                self.phase = Phase::ReadInx(2);
            }
            Phase::ReadInx(2) => {
                self.tmp = mem.read((self.tmp2 & 0xFF) as u16) as u32;
                self.tmp2 = self.tmp2.wrapping_add(1);
                self.phase = Phase::ReadInx(3);
            }
            Phase::ReadInx(3) => {
                self.tmp = self.tmp.wrapping_add((mem.read((self.tmp2 & 0xFF) as u16) as u32) * 256);
                self.phase = Phase::ReadInx(4);
            }
            Phase::ReadInx(4) => {
                self.tmp = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::ReadInx(5);
            }
            Phase::ReadInx(5) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== READ (INDIRECT),Y - 5/6 cycles ==========
            // 0: tmp2 = read(PC); PC++
            // 1: tmp = read(tmp2); tmp2 = (tmp2+1) & 0xFFFF
            // 2: tmp += read(tmp2 & 0xFF)*256
            // 3: lo = tmp&0xFF; hi = tmp&0xFF00; lo += Y;
            //    if lo < 255: tmp = read(tmp+Y); cycleCounter++
            //    else: read(hi | (lo & 0xFF))
            // 4: tmp = read(tmp+Y)
            // 5: exec; decode()
            //
            // Note: Sfotty uses `this.tmp2 = this.tmp2 + 1 & 65535` in phase 1 (iny read)
            // but then `this.tmp2 & 255` in phase 2. We match this exactly.
            Phase::ReadIny(0) => {
                self.tmp2 = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::ReadIny(1);
            }
            Phase::ReadIny(1) => {
                self.tmp = mem.read(self.tmp2 as u16) as u32;
                self.tmp2 = (self.tmp2 + 1) & 0xFFFF;
                self.phase = Phase::ReadIny(2);
            }
            Phase::ReadIny(2) => {
                self.tmp = self.tmp.wrapping_add((mem.read((self.tmp2 & 0xFF) as u16) as u32) * 256);
                self.phase = Phase::ReadIny(3);
            }
            Phase::ReadIny(3) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.y as u32;
                if new_lo < 255 {
                    self.tmp = mem.read((self.tmp + self.y as u32) as u16) as u32;
                    self.phase = Phase::ReadIny(5); // skip phase 4
                } else {
                    mem.read((hi | (new_lo & 0xFF)) as u16);
                    self.phase = Phase::ReadIny(4);
                }
            }
            Phase::ReadIny(4) => {
                self.tmp = mem.read((self.tmp.wrapping_add(self.y as u32)) as u16) as u32;
                self.phase = Phase::ReadIny(5);
            }
            Phase::ReadIny(5) => {
                self.exec_read_op();
                self.decode(mem);
            }

            // ========== STORE ZERO PAGE - 3 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: write(tmp, reg)
            // 2: decode()
            Phase::StoreZpg(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreZpg(1);
            }
            Phase::StoreZpg(1) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreZpg(2);
            }
            Phase::StoreZpg(2) => {
                self.decode(mem);
            }

            // ========== STORE ABSOLUTE - 4 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: write(tmp, reg)
            // 3: decode()
            Phase::StoreAbs(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAbs(1);
            }
            Phase::StoreAbs(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAbs(2);
            }
            Phase::StoreAbs(2) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreAbs(3);
            }
            Phase::StoreAbs(3) => {
                self.decode(mem);
            }

            // ========== STORE ZERO PAGE,X - 3 cycles ==========
            // Sfotty: tmp = (read(PC) + X) & 255; PC++
            // then write. Note: only 3 cycles total! (no dummy read like read zpx)
            // Wait - re-check Sfotty code for STA zpx:
            //   0: tmp = (read(PC) + X) & 255; PC++
            //   1: write(tmp, reg)
            //   2: decode()
            Phase::StoreZpx(0) => {
                self.tmp = ((mem.read(self.pc) as u32) + self.x as u32) & 0xFF;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreZpx(1);
            }
            Phase::StoreZpx(1) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreZpx(2);
            }
            Phase::StoreZpx(2) => {
                self.decode(mem);
            }

            // ========== STORE ZERO PAGE,Y - 3 cycles ==========
            // Same as zpx but with Y
            Phase::StoreZpy(0) => {
                self.tmp = ((mem.read(self.pc) as u32) + self.y as u32) & 0xFF;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreZpy(1);
            }
            Phase::StoreZpy(1) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreZpy(2);
            }
            Phase::StoreZpy(2) => {
                self.decode(mem);
            }

            // ========== STORE ABSOLUTE,X - 5 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: lo = tmp&0xFF; hi = tmp&0xFF00; lo += X; read(hi | (lo&0xFF)); tmp += X
            // 3: write(tmp, reg)
            // 4: decode()
            Phase::StoreAbx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAbx(1);
            }
            Phase::StoreAbx(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAbx(2);
            }
            Phase::StoreAbx(2) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.x as u32;
                mem.read((hi | (new_lo & 0xFF)) as u16);
                self.tmp = self.tmp.wrapping_add(self.x as u32);
                self.phase = Phase::StoreAbx(3);
            }
            Phase::StoreAbx(3) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreAbx(4);
            }
            Phase::StoreAbx(4) => {
                self.decode(mem);
            }

            // ========== STORE ABSOLUTE,Y - 5 cycles ==========
            Phase::StoreAby(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAby(1);
            }
            Phase::StoreAby(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreAby(2);
            }
            Phase::StoreAby(2) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.y as u32;
                mem.read((hi | (new_lo & 0xFF)) as u16);
                self.tmp = self.tmp.wrapping_add(self.y as u32);
                self.phase = Phase::StoreAby(3);
            }
            Phase::StoreAby(3) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreAby(4);
            }
            Phase::StoreAby(4) => {
                self.decode(mem);
            }

            // ========== STORE (INDIRECT,X) - 6 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(tmp); tmp2 = tmp+X
            // 2: tmp = read(tmp2++ & 0xFF)
            // 3: tmp += read(tmp2 & 0xFF)*256
            // 4: write(tmp, reg)
            // 5: decode()
            Phase::StoreInx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreInx(1);
            }
            Phase::StoreInx(1) => {
                mem.read(self.tmp as u16);
                self.tmp2 = self.tmp + self.x as u32;
                self.phase = Phase::StoreInx(2);
            }
            Phase::StoreInx(2) => {
                self.tmp = mem.read((self.tmp2 & 0xFF) as u16) as u32;
                self.tmp2 = self.tmp2.wrapping_add(1);
                self.phase = Phase::StoreInx(3);
            }
            Phase::StoreInx(3) => {
                self.tmp = self.tmp.wrapping_add((mem.read((self.tmp2 & 0xFF) as u16) as u32) * 256);
                self.phase = Phase::StoreInx(4);
            }
            Phase::StoreInx(4) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreInx(5);
            }
            Phase::StoreInx(5) => {
                self.decode(mem);
            }

            // ========== STORE (INDIRECT),Y - 6 cycles ==========
            // 0: tmp2 = read(PC); PC++
            // 1: tmp = read(tmp2++)
            // 2: tmp += read(tmp2 & 0xFF)*256
            // 3: lo = tmp&0xFF; hi = tmp&0xFF00; lo += Y; read(hi|(lo&0xFF)); tmp = tmp+Y
            // 4: write(tmp, reg)
            // 5: decode()
            Phase::StoreIny(0) => {
                self.tmp2 = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::StoreIny(1);
            }
            Phase::StoreIny(1) => {
                self.tmp = mem.read(self.tmp2 as u16) as u32;
                self.tmp2 = self.tmp2.wrapping_add(1);
                self.phase = Phase::StoreIny(2);
            }
            Phase::StoreIny(2) => {
                self.tmp = self.tmp.wrapping_add((mem.read((self.tmp2 & 0xFF) as u16) as u32) * 256);
                self.phase = Phase::StoreIny(3);
            }
            Phase::StoreIny(3) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.y as u32;
                mem.read((hi | (new_lo & 0xFF)) as u16);
                self.tmp = self.tmp.wrapping_add(self.y as u32);
                self.phase = Phase::StoreIny(4);
            }
            Phase::StoreIny(4) => {
                self.exec_store_op(mem);
                self.phase = Phase::StoreIny(5);
            }
            Phase::StoreIny(5) => {
                self.decode(mem);
            }

            // ========== RMW ACCUMULATOR - 2 cycles ==========
            // 0: read(PC) dummy; tmp2 = A
            // 1: A = rmw_op(tmp2); set NZ; decode()
            Phase::RmwAcc(0) => {
                mem.read(self.pc);
                self.tmp2 = self.a as u32;
                self.phase = Phase::RmwAcc(1);
            }
            Phase::RmwAcc(1) => {
                let r = self.exec_rmw_op();
                self.a = r;
                self.set_nz(r);
                self.decode(mem);
            }

            // ========== RMW ZERO PAGE - 5 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp2 = read(tmp)
            // 2: write(tmp, tmp2); tmp2 = rmw_op(tmp2); set NZ
            // 3: write(tmp, tmp2)
            // 4: decode()
            Phase::RmwZpg(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwZpg(1);
            }
            Phase::RmwZpg(1) => {
                self.tmp2 = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::RmwZpg(2);
            }
            Phase::RmwZpg(2) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                let r = self.exec_rmw_op();
                self.tmp2 = r as u32;
                self.set_nz(r);
                self.phase = Phase::RmwZpg(3);
            }
            Phase::RmwZpg(3) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                self.phase = Phase::RmwZpg(4);
            }
            Phase::RmwZpg(4) => {
                self.decode(mem);
            }

            // ========== RMW ABSOLUTE - 6 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: tmp2 = read(tmp)
            // 3: write(tmp, tmp2); tmp2 = rmw_op(tmp2); set NZ
            // 4: write(tmp, tmp2)
            // 5: decode()
            Phase::RmwAbs(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwAbs(1);
            }
            Phase::RmwAbs(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwAbs(2);
            }
            Phase::RmwAbs(2) => {
                self.tmp2 = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::RmwAbs(3);
            }
            Phase::RmwAbs(3) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                let r = self.exec_rmw_op();
                self.tmp2 = r as u32;
                self.set_nz(r);
                self.phase = Phase::RmwAbs(4);
            }
            Phase::RmwAbs(4) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                self.phase = Phase::RmwAbs(5);
            }
            Phase::RmwAbs(5) => {
                self.decode(mem);
            }

            // ========== RMW ZERO PAGE,X - 6 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: read(tmp) dummy
            // 2: tmp = (tmp+X) & 0xFF; tmp2 = read(tmp)
            // 3: write(tmp, tmp2); tmp2 = rmw_op(tmp2); set NZ
            // 4: write(tmp, tmp2)
            // 5: decode()
            Phase::RmwZpx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwZpx(1);
            }
            Phase::RmwZpx(1) => {
                mem.read(self.tmp as u16);
                self.phase = Phase::RmwZpx(2);
            }
            Phase::RmwZpx(2) => {
                self.tmp = (self.tmp + self.x as u32) & 0xFF;
                self.tmp2 = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::RmwZpx(3);
            }
            Phase::RmwZpx(3) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                let r = self.exec_rmw_op();
                self.tmp2 = r as u32;
                self.set_nz(r);
                self.phase = Phase::RmwZpx(4);
            }
            Phase::RmwZpx(4) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                self.phase = Phase::RmwZpx(5);
            }
            Phase::RmwZpx(5) => {
                self.decode(mem);
            }

            // ========== RMW ABSOLUTE,X - 7 cycles ==========
            // 0: tmp = read(PC); PC++
            // 1: tmp += read(PC)*256; PC++
            // 2: lo = tmp&0xFF; hi = tmp&0xFF00; lo += X; read(hi|(lo&0xFF)); tmp += X
            // 3: tmp2 = read(tmp)
            // 4: write(tmp, tmp2); tmp2 = rmw_op(tmp2); set NZ
            // 5: write(tmp, tmp2)
            // 6: decode()
            Phase::RmwAbx(0) => {
                self.tmp = mem.read(self.pc) as u32;
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwAbx(1);
            }
            Phase::RmwAbx(1) => {
                self.tmp = self.tmp.wrapping_add((mem.read(self.pc) as u32) * 256);
                self.pc = self.pc.wrapping_add(1) & 0xFFFF;
                self.phase = Phase::RmwAbx(2);
            }
            Phase::RmwAbx(2) => {
                let lo = self.tmp & 0xFF;
                let hi = self.tmp & 0xFF00;
                let new_lo = lo + self.x as u32;
                mem.read((hi | (new_lo & 0xFF)) as u16);
                self.tmp = self.tmp.wrapping_add(self.x as u32);
                self.phase = Phase::RmwAbx(3);
            }
            Phase::RmwAbx(3) => {
                self.tmp2 = mem.read(self.tmp as u16) as u32;
                self.phase = Phase::RmwAbx(4);
            }
            Phase::RmwAbx(4) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                let r = self.exec_rmw_op();
                self.tmp2 = r as u32;
                self.set_nz(r);
                self.phase = Phase::RmwAbx(5);
            }
            Phase::RmwAbx(5) => {
                mem.write(self.tmp as u16, self.tmp2 as u8);
                self.phase = Phase::RmwAbx(6);
            }
            Phase::RmwAbx(6) => {
                self.decode(mem);
            }

            // Catch-all for invalid phase indices (should never happen)
            _ => {
                self.crashed = true;
            }
        }
    }

    /// Execute a read operation (LDA, LDX, etc.) using self.tmp as the value
    fn exec_read_op(&mut self) {
        let val = self.tmp as u8;
        match self.opcode_info.read_op.unwrap() {
            ReadOp::LDA => {
                self.a = val;
                self.set_nz(val);
            }
            ReadOp::LDX => {
                self.x = val;
                self.set_nz(val);
            }
            ReadOp::LDY => {
                // Sfotty sets Z and N before assigning Y (same result)
                self.set_nz(val);
                self.y = val;
            }
            ReadOp::EOR => {
                self.a ^= val;
                self.tmp = self.a as u32;
                self.set_nz(self.a);
            }
            ReadOp::AND => {
                self.a &= val;
                self.tmp = self.a as u32;
                self.set_nz(self.a);
            }
            ReadOp::ORA => {
                self.a |= val;
                self.tmp = self.a as u32;
                self.set_nz(self.a);
            }
            ReadOp::ADC => {
                self.do_adc(val);
            }
            ReadOp::SBC => {
                self.do_sbc(val);
            }
            ReadOp::CMP => {
                // Sfotty: tmp ^= 255; diff = A + tmp + 1; C = diff > 255; tmp = diff & 255
                let inv = val ^ 0xFF;
                let diff = self.a as u32 + inv as u32 + 1;
                self.p = (self.p & !(FLAG_C | FLAG_N | FLAG_Z))
                    | if diff > 255 { FLAG_C } else { 0 }
                    | if (diff & 0xFF) == 0 { FLAG_Z } else { 0 }
                    | if diff & 0x80 != 0 { FLAG_N } else { 0 };
            }
            ReadOp::CPX => {
                let inv = val ^ 0xFF;
                let diff = self.x as u32 + inv as u32 + 1;
                self.p = (self.p & !(FLAG_C | FLAG_N | FLAG_Z))
                    | if diff > 255 { FLAG_C } else { 0 }
                    | if (diff & 0xFF) == 0 { FLAG_Z } else { 0 }
                    | if diff & 0x80 != 0 { FLAG_N } else { 0 };
            }
            ReadOp::CPY => {
                let inv = val ^ 0xFF;
                let diff = self.y as u32 + inv as u32 + 1;
                self.p = (self.p & !(FLAG_C | FLAG_N | FLAG_Z))
                    | if diff > 255 { FLAG_C } else { 0 }
                    | if (diff & 0xFF) == 0 { FLAG_Z } else { 0 }
                    | if diff & 0x80 != 0 { FLAG_N } else { 0 };
            }
            ReadOp::BIT => {
                // Sfotty: V = !!(tmp & 64); N = tmp >= 128; tmp = A & tmp; Z = !tmp
                self.p = (self.p & !(FLAG_V | FLAG_N | FLAG_Z))
                    | if val & 0x40 != 0 { FLAG_V } else { 0 }
                    | if val >= 128 { FLAG_N } else { 0 }
                    | if self.a & val == 0 { FLAG_Z } else { 0 };
            }
        }
    }

    /// Execute a store operation using self.tmp as the address
    fn exec_store_op(&self, mem: &mut BoardMemory) {
        let addr = self.tmp as u16;
        let val = match self.opcode_info.store_op.unwrap() {
            StoreOp::STA => self.a,
            StoreOp::STX => self.x,
            StoreOp::STY => self.y,
        };
        mem.write(addr, val);
    }

    /// Execute an RMW operation on self.tmp2, returning the result
    fn exec_rmw_op(&mut self) -> u8 {
        let val = self.tmp2 as u8;
        match self.opcode_info.rmw_op.unwrap() {
            RmwOp::DEC => val.wrapping_sub(1),
            RmwOp::INC => val.wrapping_add(1),
            RmwOp::LSR => {
                self.p = (self.p & !FLAG_C) | if val & 1 != 0 { FLAG_C } else { 0 };
                val >> 1
            }
            RmwOp::ASL => {
                self.p = (self.p & !FLAG_C) | if val & 128 != 0 { FLAG_C } else { 0 };
                val << 1
            }
            RmwOp::ROR => {
                let r = (val as u16) | if self.p & FLAG_C != 0 { 256 } else { 0 };
                self.p = (self.p & !FLAG_C) | if val & 1 != 0 { FLAG_C } else { 0 };
                (r >> 1) as u8
            }
            RmwOp::ROL => {
                let r = ((val as u16) << 1) | if self.p & FLAG_C != 0 { 1 } else { 0 };
                self.p = (self.p & !FLAG_C) | if r > 255 { FLAG_C } else { 0 };
                (r & 0xFF) as u8
            }
        }
    }

    /// ADC matching Sfotty's exact implementation (including BCD mode)
    fn do_adc(&mut self, val: u8) {
        if self.p & FLAG_D != 0 {
            // Decimal mode (matching Sfotty exactly)
            let c = if self.p & FLAG_C != 0 { 1i32 } else { 0 };
            let mut al = (self.a as i32 & 15) + (val as i32 & 15) + c;
            if al > 9 { al += 6; }
            let mut ah = (self.a as i32 >> 4) + (val as i32 >> 4) + if al > 15 { 1 } else { 0 };
            // V flag: ~(A ^ tmp) & (A ^ (ah << 4)) & 128
            let v = (!(self.a as i32 ^ val as i32)) & (self.a as i32 ^ (ah << 4)) & 128;
            self.p = (self.p & !FLAG_V) | if v != 0 { FLAG_V } else { 0 };
            if ah > 9 { ah += 6; }
            self.p = (self.p & !FLAG_C) | if ah > 15 { FLAG_C } else { 0 };
            let result = ((ah << 4) | (al & 15)) as u8;
            self.a = result;
            self.tmp = result as u32;
            self.set_nz(result);
        } else {
            let c = if self.p & FLAG_C != 0 { 1u32 } else { 0 };
            let sum = self.a as u32 + val as u32 + c;
            let v = (!(self.a as u32 ^ val as u32)) & (self.a as u32 ^ sum) & 128;
            self.p = (self.p & !(FLAG_C | FLAG_V))
                | if sum > 255 { FLAG_C } else { 0 }
                | if v != 0 { FLAG_V } else { 0 };
            let result = (sum & 0xFF) as u8;
            self.a = result;
            self.tmp = result as u32;
            self.set_nz(result);
        }
    }

    /// SBC matching Sfotty's exact implementation (including BCD mode)
    fn do_sbc(&mut self, val: u8) {
        if self.p & FLAG_D != 0 {
            // Decimal mode SBC (matching Sfotty exactly)
            let c = if self.p & FLAG_C != 0 { 1i32 } else { 0 };
            let inv = (!val) as u8;
            let diff = self.a as i32 + inv as i32 + c;
            let mut al = (self.a as i32 & 15) - (val as i32 & 15) - c;
            if (al as u8) > 127 { al -= 6; }
            let mut ah = (self.a as i32 >> 4) - (val as i32 >> 4) - if (al as u8) > 127 { 1 } else { 0 };
            // V flag
            let v = (self.a as i32 ^ val as i32) & (self.a as i32 ^ diff) & 128;
            self.p = (self.p & !(FLAG_V | FLAG_C))
                | if v != 0 { FLAG_V } else { 0 }
                | if diff > 255 { FLAG_C } else { 0 };  // Sfotty: this.C = diff > 255 (unsigned comparison intent? no...)
            if ah & 128 != 0 { ah -= 6; }
            let result = ((ah << 4) | (al & 15)) as u8;
            self.a = result;
            self.tmp = result as u32;
            self.set_nz(result);
        } else {
            // Non-decimal SBC (matching Sfotty exactly)
            let inv = val ^ 0xFF;
            let c = if self.p & FLAG_C != 0 { 1u32 } else { 0 };
            let carry7 = (self.a as u32 & 127) + (inv as u32 & 127) + c;
            let result = carry7 + (self.a as u32 & 128) + (inv as u32 & 128);
            self.p = (self.p & !(FLAG_N | FLAG_C | FLAG_Z | FLAG_V))
                | if result & 128 != 0 { FLAG_N } else { 0 }
                | if result >= 256 { FLAG_C } else { 0 }
                | if result & 0xFF == 0 { FLAG_Z } else { 0 }
                | if ((result >> 2) ^ (carry7 >> 1)) & 64 != 0 { FLAG_V } else { 0 };
            self.a = (result & 0xFF) as u8;
        }
    }
}

/// Check if an opcode is valid (documented NMOS 6502)
pub fn is_valid_opcode(opcode: u8) -> bool {
    match opcode {
        0x00 | 0x01 | 0x05 | 0x06 | 0x08 | 0x09 | 0x0A | 0x0D | 0x0E |
        0x10 | 0x11 | 0x15 | 0x16 | 0x18 | 0x19 | 0x1D | 0x1E |
        0x20 | 0x21 | 0x24 | 0x25 | 0x26 | 0x28 | 0x29 | 0x2A | 0x2C | 0x2D | 0x2E |
        0x30 | 0x31 | 0x35 | 0x36 | 0x38 | 0x39 | 0x3D | 0x3E |
        0x40 | 0x41 | 0x45 | 0x46 | 0x48 | 0x49 | 0x4A | 0x4C | 0x4D | 0x4E |
        0x50 | 0x51 | 0x55 | 0x56 | 0x58 | 0x59 | 0x5D | 0x5E |
        0x60 | 0x61 | 0x65 | 0x66 | 0x68 | 0x69 | 0x6A | 0x6C | 0x6D | 0x6E |
        0x70 | 0x71 | 0x75 | 0x76 | 0x78 | 0x79 | 0x7D | 0x7E |
        0x81 | 0x84 | 0x85 | 0x86 | 0x88 | 0x8A | 0x8C | 0x8D | 0x8E |
        0x90 | 0x91 | 0x94 | 0x95 | 0x96 | 0x98 | 0x99 | 0x9A | 0x9D |
        0xA0 | 0xA1 | 0xA2 | 0xA4 | 0xA5 | 0xA6 | 0xA8 | 0xA9 | 0xAA | 0xAC | 0xAD | 0xAE |
        0xB0 | 0xB1 | 0xB4 | 0xB5 | 0xB6 | 0xB8 | 0xB9 | 0xBA | 0xBC | 0xBD | 0xBE |
        0xC0 | 0xC1 | 0xC4 | 0xC5 | 0xC6 | 0xC8 | 0xC9 | 0xCA | 0xCC | 0xCD | 0xCE |
        0xD0 | 0xD1 | 0xD5 | 0xD6 | 0xD8 | 0xD9 | 0xDD | 0xDE |
        0xE0 | 0xE1 | 0xE4 | 0xE5 | 0xE6 | 0xE8 | 0xE9 | 0xEA | 0xEC | 0xED | 0xEE |
        0xF0 | 0xF1 | 0xF5 | 0xF6 | 0xF8 | 0xF9 | 0xFD | 0xFE => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cpu_mem() -> (Cpu, BoardMemory) {
        let mut cpu = Cpu::new();
        cpu.reset_pending = false;
        cpu.phase = Phase::Decode;
        (cpu, BoardMemory::new(42, 8))
    }

    /// Run one instruction through the Sfotty-compatible cycle machine.
    /// First run() is the bootstrap decode (1 cycle), then subsequent run()
    /// calls execute the instruction's phases until cycle_counter == 0 again.
    /// Returns the number of instruction cycles (NOT including the bootstrap decode).
    ///
    /// Note: after this returns, the decode for the NEXT instruction has already
    /// run (as the last phase of the current instruction), so PC will be past
    /// the next instruction's opcode byte.
    fn run_instruction(cpu: &mut Cpu, mem: &mut BoardMemory) -> u32 {
        // Bootstrap decode: run() executes Phase::Decode, which sets up the instruction
        assert_eq!(cpu.cycle_counter, 0);
        cpu.run(mem);
        assert_eq!(cpu.cycle_counter, 0, "After bootstrap decode, cycle_counter should be 0");
        if cpu.crashed {
            return 1;
        }

        // Now run the instruction's phases until cycle_counter returns to 0
        let mut cycles = 0u32;
        loop {
            cpu.run(mem);
            cycles += 1;
            if cpu.cycle_counter == 0 || cpu.crashed {
                break;
            }
        }
        cycles
    }

    #[test]
    fn test_nop() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0xEA); // NOP
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
    }

    #[test]
    fn test_lda_immediate() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0xA9); // LDA #$42
        mem.write(0x0001, 0x42);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
        assert_eq!(cpu.a, 0x42);
    }

    #[test]
    fn test_lda_zeropage() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0xA5); // LDA $10
        mem.write(0x0001, 0x10);
        mem.write(0x0010, 0x77);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        assert_eq!(cpu.a, 0x77);
    }

    #[test]
    fn test_lda_absolute() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0xAD); // LDA $0300
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x03);
        mem.write(0x0300, 0x55);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 4);
        assert_eq!(cpu.a, 0x55);
    }

    #[test]
    fn test_lda_absolute_x_no_cross() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 0x05;
        mem.write(0x0000, 0xBD); // LDA $0300,X
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x03);
        mem.write(0x0305, 0xAA);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 4);
        assert_eq!(cpu.a, 0xAA);
    }

    #[test]
    fn test_lda_absolute_x_page_cross() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 0xFF;
        mem.write(0x0000, 0xBD); // LDA $0301,X  -> reads $0400
        mem.write(0x0001, 0x01);
        mem.write(0x0002, 0x03);
        mem.write(0x0400, 0xBB);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 5);
        assert_eq!(cpu.a, 0xBB);
    }

    #[test]
    fn test_sta_zeropage() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x99;
        mem.write(0x0000, 0x85); // STA $10
        mem.write(0x0001, 0x10);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        assert_eq!(mem.read(0x0010), 0x99);
    }

    #[test]
    fn test_sta_zpx() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x42;
        cpu.x = 0x05;
        mem.write(0x0000, 0x95); // STA $10,X
        mem.write(0x0001, 0x10);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        assert_eq!(mem.read(0x0015), 0x42);
    }

    #[test]
    fn test_jmp_absolute() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0x4C); // JMP $0200
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x02);
        mem.write(0x0200, 0xEA); // NOP at target (for next decode)
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        // After JMP + next decode, PC = 0x0201 (target + 1 from next decode)
        assert_eq!(cpu.pc, 0x0201);
    }

    #[test]
    fn test_jmp_indirect() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0x6C); // JMP ($0300)
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x03);
        mem.write(0x0300, 0x50);
        mem.write(0x0301, 0x04);
        mem.write(0x0450, 0xEA); // NOP at target
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 5);
        assert_eq!(cpu.pc, 0x0451);
    }

    #[test]
    fn test_inx() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 0x05;
        mem.write(0x0000, 0xE8); // INX
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
        assert_eq!(cpu.x, 0x06);
    }

    #[test]
    fn test_branch_not_taken() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.p |= FLAG_Z; // Z set
        mem.write(0x0000, 0xD0); // BNE (not taken since Z is set)
        mem.write(0x0001, 0x05);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
    }

    #[test]
    fn test_branch_taken_same_page() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.p &= !FLAG_Z; // Z clear
        mem.write(0x0000, 0xD0); // BNE +5 (taken, same page)
        mem.write(0x0001, 0x05);
        mem.write(0x0007, 0xEA); // NOP at target
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        // Target = PC+2+5 = 7, after decode PC = 8
        assert_eq!(cpu.pc, 0x0008);
    }

    #[test]
    fn test_branch_taken_page_cross() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.pc = 0x00F0;
        cpu.p &= !FLAG_Z;
        mem.write(0x00F0, 0xD0); // BNE +$20
        mem.write(0x00F1, 0x20);
        // Target = 0x00F2 + 0x20 = 0x0112
        mem.write(0x0112, 0xEA);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 4);
        assert_eq!(cpu.pc, 0x0113);
    }

    #[test]
    fn test_jsr_rts() {
        let (mut cpu, mut mem) = make_cpu_mem();
        // JSR $0200
        mem.write(0x0000, 0x20);
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x02);
        mem.write(0x0200, 0x60); // RTS at target
        cpu.s = 0xFF;
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 6);
        // After JSR + next decode (decodes RTS at 0x0200), PC = 0x0201
        assert_eq!(cpu.pc, 0x0201);
        assert_eq!(cpu.s, 0xFD);

        // Now run RTS (already decoded)
        let mut cycles2 = 0u32;
        loop {
            cpu.run(&mut mem);
            cycles2 += 1;
            if cpu.cycle_counter == 0 || cpu.crashed {
                break;
            }
        }
        assert_eq!(cycles2, 6);
        // RTS returns to 0x0002+1 = 0x0003, then decode reads next opcode
    }

    #[test]
    fn test_brk() {
        // Note: BRK reads IRQ vector from 0xFFFE-0xFFFF which is outside the
        // memory-mapped neighborhood (max 49*1024 = 0xC400). In the real system,
        // the controller intercepts BRK before the CPU executes it.
        // Here we just verify BRK takes 7 cycles and reads the vector.
        // With unmapped addresses, the vector will be 0x0000.
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.s = 0xFF;
        mem.write(0x0000, 0x00); // BRK
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 7);
        // IRQ vector at 0xFFFE/0xFFFF returns 0, so PC goes to 0x0000
        // Then decode reads BRK again. BRK advances PC by 1 in decode.
        // So PC = 0x0001 after the decode at 0x0000.
        assert_eq!(cpu.s, 0xFC); // pushed 3 bytes: PCH, PCL, P
    }

    #[test]
    fn test_pha_pla() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x42;
        cpu.s = 0xFF;
        mem.write(0x0000, 0x48); // PHA
        mem.write(0x0001, 0x68); // PLA (next instruction)
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 3);
        assert_eq!(cpu.s, 0xFE);
        assert_eq!(mem.read(0x01FF), 0x42);

        // PLA is already decoded, run its phases
        cpu.a = 0x00;
        let mut cycles2 = 0u32;
        loop {
            cpu.run(&mut mem);
            cycles2 += 1;
            if cpu.cycle_counter == 0 || cpu.crashed {
                break;
            }
        }
        assert_eq!(cycles2, 4);
        assert_eq!(cpu.a, 0x42);
    }

    #[test]
    fn test_asl_accumulator() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x81;
        mem.write(0x0000, 0x0A); // ASL A
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
        assert_eq!(cpu.a, 0x02);
        assert!(cpu.p & FLAG_C != 0); // carry set (bit 7 was 1)
    }

    #[test]
    fn test_inc_zeropage() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0xE6); // INC $10
        mem.write(0x0001, 0x10);
        mem.write(0x0010, 0xFF);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 5);
        assert_eq!(mem.read(0x0010), 0x00);
        assert!(cpu.p & FLAG_Z != 0);
    }

    #[test]
    fn test_tsx_does_not_set_flags() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.s = 0x00;
        cpu.p = FLAG_U | FLAG_I; // Z and N clear
        mem.write(0x0000, 0xBA); // TSX
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 2);
        assert_eq!(cpu.x, 0x00);
        assert!(cpu.p & FLAG_Z == 0); // Sfotty bug: TSX doesn't set Z
    }

    #[test]
    fn test_valid_opcode_check() {
        assert!(is_valid_opcode(0xA9));
        assert!(is_valid_opcode(0xEA));
        assert!(is_valid_opcode(0x00));
        assert!(!is_valid_opcode(0x02));
        assert!(!is_valid_opcode(0xFF));
    }

    #[test]
    fn test_undocumented_opcode_crashes() {
        let (mut cpu, mut mem) = make_cpu_mem();
        mem.write(0x0000, 0x02);
        cpu.run(&mut mem); // bootstrap decode
        assert_eq!(cpu.cycle_counter, 0); // decode resets CC
        // After bootstrap, the next decode should crash
        // Actually the bootstrap decode reads 0x02 and crashes
        assert!(cpu.crashed);
    }

    #[test]
    fn test_reset_sequence() {
        let mut cpu = Cpu::new();
        let mut mem = BoardMemory::new(42, 8);
        mem.write(0xFFFC, 0x00);
        mem.write(0xFFFD, 0x04);
        assert!(cpu.reset_pending);
        // First run() triggers decode which sets up reset sequence (1 cycle)
        // Then 7 cycles for the reset phases (including final decode)
        let mut total = 0;
        loop {
            cpu.run(&mut mem);
            total += 1;
            if cpu.cycle_counter == 0 && !cpu.reset_pending {
                // Check if we're past the reset
                if total > 1 {
                    break;
                }
            }
            if total > 100 { panic!("reset sequence took too long"); }
        }
        // Bootstrap decode (1) + 7 reset phases = 8 total run() calls
        // But the reset is 7 operations ending with decode
        // Let me think: first run() calls decode(), which sees resetPending,
        // sets up Reset(0..6) and resets CC=0. That's 1 call.
        // Then 7 more calls for Reset(0) through Reset(6).
        // Reset(6) calls decode(), which decodes the first instruction at the reset vector.
        // Total: 1 + 7 = 8 run() calls.
        assert_eq!(total, 8);
    }

    #[test]
    fn test_sta_absolute_x() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.a = 0x42;
        cpu.x = 0x10;
        mem.write(0x0000, 0x9D); // STA $0300,X
        mem.write(0x0001, 0x00);
        mem.write(0x0002, 0x03);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 5);
        assert_eq!(mem.read(0x0310), 0x42);
    }

    #[test]
    fn test_lda_indirect_x() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 0x04;
        mem.write(0x0000, 0xA1); // LDA ($20,X) -> reads from ($24)
        mem.write(0x0001, 0x20);
        mem.write(0x0024, 0x00);
        mem.write(0x0025, 0x03);
        mem.write(0x0300, 0xAB);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 6);
        assert_eq!(cpu.a, 0xAB);
    }

    #[test]
    fn test_lda_indirect_y_no_cross() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.y = 0x05;
        mem.write(0x0000, 0xB1); // LDA ($20),Y
        mem.write(0x0001, 0x20);
        mem.write(0x0020, 0x00);
        mem.write(0x0021, 0x03);
        mem.write(0x0305, 0xCD);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 5);
        assert_eq!(cpu.a, 0xCD);
    }

    #[test]
    fn test_lda_indirect_y_page_cross() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.y = 0xFF;
        mem.write(0x0000, 0xB1); // LDA ($20),Y
        mem.write(0x0001, 0x20);
        mem.write(0x0020, 0x01);
        mem.write(0x0021, 0x03);
        mem.write(0x0400, 0xEF);
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 6);
        assert_eq!(cpu.a, 0xEF);
    }

    #[test]
    fn test_rti() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.s = 0xFC;
        mem.write(0x01FD, 0x24); // P
        mem.write(0x01FE, 0x00); // PCL
        mem.write(0x01FF, 0x04); // PCH
        mem.write(0x0000, 0x40); // RTI
        mem.write(0x0400, 0xEA); // NOP at return address
        let cycles = run_instruction(&mut cpu, &mut mem);
        assert_eq!(cycles, 6);
        // After RTI + decode at 0x0400, PC = 0x0401
        assert_eq!(cpu.pc, 0x0401);
    }

    #[test]
    fn test_page_cross_boundary_lo_254() {
        let (mut cpu, mut mem) = make_cpu_mem();
        cpu.x = 1;
        mem.write(0x0000, 0xBD); // LDA $00FE,X
        mem.write(0x0001, 0xFE);
        mem.write(0x0002, 0x00);
        mem.write(0x00FF, 0x42);
        let cycles = run_instruction(&mut cpu, &mut mem);
        // lo (0xFE) + X (1) = 255, NOT < 255 => page cross path
        assert_eq!(cycles, 5);
        assert_eq!(cpu.a, 0x42);
    }
}
