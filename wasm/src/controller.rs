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

pub struct BoardController {
    pub memory: BoardMemory,
    pub cpu: Cpu,
    pub total_cycles: u64,
    pub last_move_time: Vec<u64>,
    pub last_write_time: Vec<u64>,
    pub p_bit_noise: f64,
}

pub struct InterruptResult {
    pub cpu_cycles: u32,
    pub scheduler_cycles: u32,
}

impl BoardController {
    pub fn new(memory: BoardMemory) -> Self {
        let num_cells = memory.board_size * memory.board_size;
        let mut ctrl = BoardController {
            memory,
            cpu: Cpu::new(),
            total_cycles: 0,
            last_move_time: vec![0u64; num_cells],
            last_write_time: vec![0u64; num_cells],
            p_bit_noise: 1.0 / 2048.0,
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
    }

    fn copy_cell_with_noise(&mut self, dest: usize) {
        let src_base = self.memory.neighbor_cell_storage_base(0);
        let dst_base = self.memory.neighbor_cell_storage_base(dest);
        let eps = self.p_bit_noise;

        if eps == 0.0 {
            // Perfect copy
            for b in 0..M {
                self.memory.storage[dst_base + b] = self.memory.storage[src_base + b];
            }
        } else {
            for b in 0..M {
                let src_byte = self.memory.storage[src_base + b];
                let rnd_byte = (self.memory.mt.int() & 0xFF) as u8;
                let mut noise_bits: u8 = 0;
                for bit in 0..8 {
                    if self.memory.mt.real() < eps {
                        noise_bits |= 1 << bit;
                    }
                }
                self.memory.storage[dst_base + b] =
                    (rnd_byte & noise_bits) | (src_byte & !noise_bits);
            }
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
        for addr in keys {
            let (i, j, b) = self.memory.ijb_from_byte_index(addr);
            let cell_idx = self.memory.ij_to_cell_index(i, j);
            self.last_write_time[cell_idx] = self.total_cycles;
            let _ = b; // per-byte tracking omitted for now (memory savings)
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
                        let n_dest_cells = N_SQUARED; // 49
                        let n_src_cells = 5;
                        if operand > 0 && (operand as usize) < n_src_cells * n_dest_cells {
                            let src = (operand as usize) / n_dest_cells;
                            let dest = (operand as usize) % n_dest_cells;
                            self.commit_move(src, dest);
                        } else if operand >= 245 && operand <= 252 {
                            let dest = (operand - 244) as usize;
                            self.copy_cell_with_noise(dest);
                            self.last_move_time[0] = self.total_cycles;
                            self.last_move_time[dest] = self.total_cycles;
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

                self.memory.sample_next_move();
                self.read_registers();
                self.write_rng();
                self.cpu.crashed = false;
                self.cpu.cycle_counter = 0;

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
}
