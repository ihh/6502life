/// BoardController — orchestrates CPU execution with preemptive scheduling.
/// Port of board/controller.js.

use crate::cpu::{is_valid_opcode, Cpu};
use crate::memory::{BoardMemory, M, N_SQUARED};

// Register addresses in cell zero-page
const REG_PCHI: usize = 0xF9;
const REG_PCLO: usize = 0xFA;
const REG_P: usize = 0xFB;
const REG_A: usize = 0xFC;
const REG_X: usize = 0xFD;
const REG_Y: usize = 0xFE;
const REG_S: usize = 0xFF;
const RNG_ADDR: usize = 0xFC;

/// Board hyperparameters — replaces the old flat noiseParams.
#[derive(Clone, Debug)]
pub struct BoardParams {
    /// Per-bit noise on BRK noisy copy
    pub p_bit_noise: f64,
    /// Cycle budget for BRK copy/swap (0 = no limit)
    pub n_swap_cycles: u32,
    /// P(resampled bit = 0); 0.5 = fair coin, 1.0 = erasure
    pub p_bit_noise_zero: f64,
    /// Write orientation to $FA if true
    pub has_compass: bool,
    /// BRK 1-48 swap cell 0 with cell N
    pub implements_move: bool,
    /// BRK 49-96 noisy copy cell 0 to cell N-48
    pub implements_copy: bool,
    /// BRK 97 sync interrupt request
    pub implements_sync: bool,
    /// BRK 98 async interrupt request
    pub implements_async: bool,
}

impl Default for BoardParams {
    fn default() -> Self {
        BoardParams {
            p_bit_noise: 1.0 / 2048.0,
            n_swap_cycles: 0,
            p_bit_noise_zero: 0.5,
            has_compass: false,
            implements_move: true,
            implements_copy: true,
            implements_sync: false,
            implements_async: false,
        }
    }
}

pub struct BoardController {
    pub memory: BoardMemory,
    pub cpu: Cpu,
    pub total_cycles: u64,
    pub last_move_time: Vec<u64>,
    pub last_write_time: Vec<u64>,
    pub board_params: BoardParams,
    /// Per-cell requested interrupt time (for sync/async). Infinity = none pending.
    pub next_requested_interrupt: Vec<f64>,
    /// Per-cell lastWriter: wallet ID of the board that last wrote to this cell.
    /// NOT in cell memory — programs cannot read or tamper with it.
    pub last_writer: Vec<String>,
    /// Board owner wallet ID — callers set this to their wallet ID.
    pub board_owner: String,
}

pub struct InterruptResult {
    pub cpu_cycles: u32,
    pub scheduler_cycles: u32,
}

impl BoardController {
    pub fn new(memory: BoardMemory) -> Self {
        Self::with_params(memory, BoardParams::default())
    }

    pub fn with_params(memory: BoardMemory, board_params: BoardParams) -> Self {
        let num_cells = memory.board_size * memory.board_size;
        let mut ctrl = BoardController {
            memory,
            cpu: Cpu::new(),
            total_cycles: 0,
            last_move_time: vec![0u64; num_cells],
            last_write_time: vec![0u64; num_cells],
            board_params,
            next_requested_interrupt: vec![f64::INFINITY; num_cells],
            last_writer: vec![String::new(); num_cells],
            board_owner: String::new(),
        };
        ctrl.read_registers();
        ctrl.write_rng();
        ctrl
    }

    pub fn board_size(&self) -> usize {
        self.memory.board_size
    }

    fn read_registers(&mut self) {
        let base = self.memory.neighbor_cell_storage_base(0);
        let s = &self.memory.storage;
        self.cpu.pc = ((s[base + REG_PCHI] as u16) << 8) | (s[base + REG_PCLO] as u16);
        self.cpu.p = s[base + REG_P];
        self.cpu.a = s[base + REG_A];
        self.cpu.x = s[base + REG_X];
        self.cpu.y = s[base + REG_Y];
        self.cpu.s = s[base + REG_S];
    }

    fn write_registers(&mut self) {
        let base = self.memory.neighbor_cell_storage_base(0);
        let s = &mut self.memory.storage;
        s[base + REG_PCHI] = (self.cpu.pc >> 8) as u8;
        s[base + REG_PCLO] = (self.cpu.pc & 0xFF) as u8;
        s[base + REG_P] = self.cpu.p;
        s[base + REG_A] = self.cpu.a;
        s[base + REG_X] = self.cpu.x;
        s[base + REG_Y] = self.cpu.y;
        s[base + REG_S] = self.cpu.s;
    }

    fn write_rng(&mut self) {
        let base = self.memory.neighbor_cell_storage_base(0);
        let rnd = self.memory.next_rnd;
        let s = &mut self.memory.storage;
        s[base + RNG_ADDR] = ((rnd >> 24) & 0xFF) as u8;
        s[base + RNG_ADDR + 1] = ((rnd >> 16) & 0xFF) as u8;
        s[base + RNG_ADDR + 2] = ((rnd >> 8) & 0xFF) as u8;
        s[base + RNG_ADDR + 3] = (rnd & 0xFF) as u8;
    }

    fn swap_cells(&mut self, i: usize, j: usize) {
        let i_base = self.memory.neighbor_cell_storage_base(i);
        let j_base = self.memory.neighbor_cell_storage_base(j);
        let storage = &mut self.memory.storage;
        for b in 0..M {
            storage.swap(i_base + b, j_base + b);
        }
        // Swap lastWriter along with cell content
        let i_cell = i_base / M;
        let j_cell = j_base / M;
        self.last_writer.swap(i_cell, j_cell);
    }

    fn copy_cell_with_noise(&mut self, dest: usize) {
        let src_base = self.memory.neighbor_cell_storage_base(0);
        let dst_base = self.memory.neighbor_cell_storage_base(dest);
        let eps = self.board_params.p_bit_noise;
        let q = self.board_params.p_bit_noise_zero;
        let mut perfect = true;

        if eps == 0.0 {
            // Perfect copy
            for b in 0..M {
                self.memory.storage[dst_base + b] = self.memory.storage[src_base + b];
            }
        } else {
            for b in 0..M {
                let src_byte = self.memory.storage[src_base + b];
                // Generate replacement byte: each bit is 0 with probability q
                let rnd_byte: u8 = if q == 0.5 {
                    (self.memory.mt.int() & 0xFF) as u8  // fast path: fair coin
                } else if q >= 1.0 {
                    0x00  // erasure
                } else if q <= 0.0 {
                    0xFF
                } else {
                    let mut rb: u8 = 0;
                    for bit in 0..8 {
                        if self.memory.mt.real() >= q {
                            rb |= 1 << bit;
                        }
                    }
                    rb
                };
                let mut noise_bits: u8 = 0;
                for bit in 0..8 {
                    if self.memory.mt.real() < eps {
                        noise_bits |= 1 << bit;
                    }
                }
                if noise_bits != 0 {
                    perfect = false;
                }
                self.memory.storage[dst_base + b] =
                    (rnd_byte & noise_bits) | (src_byte & !noise_bits);
            }
        }
        // Update lastWriter: perfect copy preserves provenance, imperfect clears it
        let src_cell = src_base / M;
        let dst_cell = dst_base / M;
        if perfect {
            self.last_writer[dst_cell] = self.last_writer[src_cell].clone();
        } else {
            self.last_writer[dst_cell] = String::new();
        }
    }

    pub fn randomize(&mut self) {
        let size = self.memory.storage_size();
        let mut idx = 0;
        while idx + 3 < size {
            let r = self.memory.mt.int();
            self.memory.storage[idx] = ((r >> 24) & 0xFF) as u8;
            self.memory.storage[idx + 1] = ((r >> 16) & 0xFF) as u8;
            self.memory.storage[idx + 2] = ((r >> 8) & 0xFF) as u8;
            self.memory.storage[idx + 3] = (r & 0xFF) as u8;
            idx += 4;
        }
        self.memory.reset_undo_history();
        self.read_registers();
        self.write_rng();
    }

    fn commit_writes(&mut self) {
        let keys = self.memory.undo_history_keys();
        let mut written_cells = std::collections::HashSet::new();
        for addr in keys {
            let (i, j, b) = self.memory.ijb_from_byte_index(addr);
            let cell_idx = self.memory.ij_to_cell_index(i, j);
            self.last_write_time[cell_idx] = self.total_cycles;
            let _ = b; // per-byte tracking omitted for now (memory savings)
            written_cells.insert(cell_idx);
        }
        // Set lastWriter for any written-to cell to the board owner
        if !self.board_owner.is_empty() {
            for cell_idx in written_cells {
                self.last_writer[cell_idx] = self.board_owner.clone();
            }
        }
        self.memory.disable_undo_history();
        self.write_registers();
    }

    fn commit_move(&mut self, src: usize, dest: usize) {
        if src != dest {
            self.swap_cells(src, dest);
        }
        self.last_move_time[src] = self.total_cycles;
        self.last_move_time[dest] = self.total_cycles;
        let t = self.last_write_time[src];
        self.last_write_time[src] = self.last_write_time[dest];
        self.last_write_time[dest] = t;
    }

    pub fn run_to_next_interrupt(&mut self) -> InterruptResult {
        let scheduler_cycles = self.memory.next_cycles;
        let mut cpu_cycles: u32 = 0;

        loop {
            let mut is_software_interrupt = false;
            let mut is_brk = false;
            let mut brk_operand: u8 = 0;
            let elapsed_cycles: u32;

            if self.cpu.cycle_counter == 0 {
                let next_opcode = self.memory.read(self.cpu.pc);
                is_brk = next_opcode == 0;
                let is_bad_opcode = !is_valid_opcode(next_opcode);
                is_software_interrupt = is_brk || is_bad_opcode;
            }

            if is_software_interrupt {
                elapsed_cycles = 7;
                if is_brk {
                    brk_operand = self.memory.read(self.cpu.pc.wrapping_add(1));
                }
                self.cpu.pc = if is_brk && brk_operand == 0 {
                    0
                } else {
                    self.cpu.pc.wrapping_add(2)
                };
            } else {
                self.cpu.run(&mut self.memory);
                elapsed_cycles = 1;
            }

            cpu_cycles += elapsed_cycles;
            self.total_cycles += elapsed_cycles as u64;

            let is_timer_interrupt = cpu_cycles >= scheduler_cycles;
            if is_timer_interrupt || is_software_interrupt {
                if is_timer_interrupt && self.cpu.flag_i() {
                    self.memory.undo_writes();
                } else {
                    if is_brk {
                        let operand = brk_operand;
                        let bp = &self.board_params;
                        // nSwapCycles: BRK copy/swap fails if fewer cycles remain
                        let brk_fails = bp.n_swap_cycles > 0
                            && (scheduler_cycles - cpu_cycles) < bp.n_swap_cycles as usize;
                        if !brk_fails {
                            // Clone board_params fields we need to avoid borrow issues
                            let implements_move = bp.implements_move;
                            let implements_copy = bp.implements_copy;
                            let implements_sync = bp.implements_sync;
                            let implements_async = bp.implements_async;

                            if operand >= 1 && operand <= 48 && implements_move {
                                // Swap cell 0 (origin) with cell N
                                self.commit_move(0, operand as usize);
                            } else if operand >= 49 && operand <= 96 && implements_copy {
                                let dest = (operand - 48) as usize; // cells 1-48
                                self.copy_cell_with_noise(dest);
                                self.last_move_time[0] = self.total_cycles;
                                self.last_move_time[dest] = self.total_cycles;
                            } else if operand == 97 && implements_sync {
                                // Sync interrupt request: X,Y = LSB,MSB of period.
                                let period =
                                    (self.cpu.x as u64) | ((self.cpu.y as u64) << 8);
                                if period > 0 {
                                    let next_time = ((self.total_cycles / period) + 1) * period;
                                    let cell_idx = self.memory.ij_to_cell_index(
                                        self.memory.i_orig,
                                        self.memory.j_orig,
                                    );
                                    self.next_requested_interrupt[cell_idx] =
                                        next_time as f64;
                                }
                            } else if operand == 98 && implements_async {
                                // Async interrupt request: X,Y = LSB,MSB of delay.
                                let delay =
                                    (self.cpu.x as u64) | ((self.cpu.y as u64) << 8);
                                if delay > 0 {
                                    let cell_idx = self.memory.ij_to_cell_index(
                                        self.memory.i_orig,
                                        self.memory.j_orig,
                                    );
                                    self.next_requested_interrupt[cell_idx] =
                                        (self.total_cycles + delay) as f64;
                                }
                            }
                            // Operand 255 or unimplemented: just yield (no operation)
                        }
                    }
                    self.commit_writes();
                    // B flag
                    {
                        let base = self.memory.neighbor_cell_storage_base(0);
                        let p_addr = base + REG_P;
                        if is_software_interrupt {
                            self.memory.storage[p_addr] |= 0x10; // set B
                        } else {
                            self.memory.storage[p_addr] &= !0x10; // clear B
                        }
                    }
                    self.memory.reset_undo_history();
                }

                // Randomize: pick next cell, load its state.
                self.memory.sample_next_move();

                // Check for pending sync/async interrupt requests.
                if self.board_params.implements_sync || self.board_params.implements_async {
                    let b = self.memory.board_size;
                    let now = self.total_cycles as f64;
                    let mut candidates = Vec::new();
                    for idx in 0..(b * b) {
                        if self.next_requested_interrupt[idx] <= now {
                            candidates.push(idx);
                        }
                    }
                    if !candidates.is_empty() {
                        // Pick randomly among eligible cells
                        let pick =
                            candidates[(self.memory.mt.int() as usize) % candidates.len()];
                        let i = pick / b;
                        let j = pick % b;
                        self.memory.i_orig = i;
                        self.memory.j_orig = j;
                        // Orientation is still random (from sample_next_move)
                        // Clear the pending interrupt
                        self.next_requested_interrupt[pick] = f64::INFINITY;
                    }
                }

                self.read_registers();
                self.write_rng();

                // Magnetosensing: write orientation to $FA (PCLO register area)
                // shifted left 2 bits to match oriented register format.
                {
                    let base = self.memory.neighbor_cell_storage_base(0);
                    self.memory.storage[base + 0xFA] = if self.board_params.has_compass {
                        (self.memory.orientation << 2) as u8
                    } else {
                        0
                    };
                }

                self.cpu.reset_for_new_cell();

                break;
            }
        }

        InterruptResult {
            cpu_cycles,
            scheduler_cycles,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_controller_creation() {
        let mem = BoardMemory::new(42, 8);
        let ctrl = BoardController::new(mem);
        assert_eq!(ctrl.board_size(), 8);
        assert_eq!(ctrl.total_cycles, 0);
    }

    #[test]
    fn test_controller_with_params() {
        let mem = BoardMemory::new(42, 8);
        let params = BoardParams {
            has_compass: true,
            implements_sync: true,
            implements_async: true,
            ..Default::default()
        };
        let ctrl = BoardController::with_params(mem, params);
        assert_eq!(ctrl.board_size(), 8);
        assert!(ctrl.board_params.has_compass);
        assert!(ctrl.board_params.implements_sync);
        assert!(ctrl.board_params.implements_async);
    }

    #[test]
    fn test_run_to_next_interrupt() {
        let mem = BoardMemory::new(42, 8);
        let mut ctrl = BoardController::new(mem);
        let result = ctrl.run_to_next_interrupt();
        assert!(result.cpu_cycles > 0);
        assert!(result.scheduler_cycles > 0);
        assert!(ctrl.total_cycles > 0);
    }

    #[test]
    fn test_multiple_interrupts() {
        let mem = BoardMemory::new(42, 8);
        let mut ctrl = BoardController::new(mem);
        for _ in 0..100 {
            ctrl.run_to_next_interrupt();
        }
        assert!(ctrl.total_cycles > 100);
    }

    #[test]
    fn test_randomize() {
        let mem = BoardMemory::new(42, 8);
        let mut ctrl = BoardController::new(mem);
        ctrl.randomize();
        // After randomize, storage should have non-zero bytes
        let non_zero = ctrl.memory.storage.iter().filter(|&&b| b != 0).count();
        assert!(non_zero > 0);
    }

    #[test]
    fn test_deterministic_execution() {
        // Two controllers with same seed should produce identical results
        let mem1 = BoardMemory::new(42, 8);
        let mem2 = BoardMemory::new(42, 8);
        let mut ctrl1 = BoardController::new(mem1);
        let mut ctrl2 = BoardController::new(mem2);
        for _ in 0..50 {
            let r1 = ctrl1.run_to_next_interrupt();
            let r2 = ctrl2.run_to_next_interrupt();
            assert_eq!(r1.cpu_cycles, r2.cpu_cycles);
            assert_eq!(r1.scheduler_cycles, r2.scheduler_cycles);
        }
        assert_eq!(ctrl1.total_cycles, ctrl2.total_cycles);
        assert_eq!(ctrl1.memory.storage, ctrl2.memory.storage);
    }

    #[test]
    fn test_swap_cycle_budget() {
        let mem = BoardMemory::new(42, 8);
        let params = BoardParams {
            n_swap_cycles: 999999, // always fail (budget exceeds any quantum)
            ..Default::default()
        };
        let mut ctrl = BoardController::with_params(mem, params);
        // Should still run without panicking
        for _ in 0..50 {
            ctrl.run_to_next_interrupt();
        }
        assert!(ctrl.total_cycles > 0);
    }

    #[test]
    fn test_has_compass_writes_orientation() {
        let mem = BoardMemory::new(42, 8);
        let params = BoardParams {
            has_compass: true,
            ..Default::default()
        };
        let mut ctrl = BoardController::with_params(mem, params);
        ctrl.run_to_next_interrupt();
        // After an interrupt, $FA in the origin cell should have orientation << 2
        let base = ctrl.memory.neighbor_cell_storage_base(0);
        let fa_val = ctrl.memory.storage[base + 0xFA];
        let expected = (ctrl.memory.orientation << 2) as u8;
        assert_eq!(fa_val, expected);
    }

    #[test]
    fn test_no_has_compass_writes_zero() {
        let mem = BoardMemory::new(42, 8);
        let params = BoardParams {
            has_compass: false,
            ..Default::default()
        };
        let mut ctrl = BoardController::with_params(mem, params);
        ctrl.run_to_next_interrupt();
        let base = ctrl.memory.neighbor_cell_storage_base(0);
        let fa_val = ctrl.memory.storage[base + 0xFA];
        assert_eq!(fa_val, 0);
    }

    #[test]
    fn test_feature_flags_disabled() {
        let mem = BoardMemory::new(42, 8);
        let params = BoardParams {
            implements_move: false,
            implements_copy: false,
            ..Default::default()
        };
        let mut ctrl = BoardController::with_params(mem, params);
        // Should still run without panicking even with move/copy disabled
        for _ in 0..100 {
            ctrl.run_to_next_interrupt();
        }
        assert!(ctrl.total_cycles > 0);
    }

    #[test]
    fn test_next_requested_interrupt_initialized() {
        let mem = BoardMemory::new(42, 8);
        let ctrl = BoardController::new(mem);
        assert_eq!(ctrl.next_requested_interrupt.len(), 8 * 8);
        for &t in &ctrl.next_requested_interrupt {
            assert!(t == f64::INFINITY);
        }
    }
}
