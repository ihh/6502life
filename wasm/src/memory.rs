/// BoardMemory — manages the grid of interconnected 6502 cells.
/// Port of board/memory.js.

use crate::mt::MersenneTwister;
use crate::tables::{INV_ROTATION_TABLE, ROTATION_TABLE, SPIRAL, TRANSFORM_TABLE};
use std::collections::HashMap;

pub struct BoardMemory {
    pub storage: Vec<u8>,
    pub mt: MersenneTwister,
    pub board_size: usize,
    pub i_orig: usize,
    pub j_orig: usize,
    pub orientation: usize,
    pub next_cycles: u32,
    pub next_rnd: u32,
    undo_history: Option<HashMap<usize, u8>>,
}

// Constants
pub const M: usize = 1024; // bytes per cell
pub const LOG2_M: usize = 10;
pub const N: usize = 7; // neighborhood dimension
pub const N_SQUARED: usize = 49; // neighborhood cells
const BYTE_OFFSET_MASK: usize = M - 1; // 0x3FF

// Address ranges
const FIRST_VECTOR_ADDR: usize = 0x00F0;
const LAST_VECTOR_ADDR: usize = 0x00F9;
const FIRST_LOOKUP_TABLE_ADDR: usize = 0xE000;
const LAST_LOOKUP_TABLE_ADDR: usize = 0xEFFF;

impl BoardMemory {
    pub fn new(seed: u32, board_size: usize) -> Self {
        let storage_size = board_size * board_size * M;
        let mut mem = BoardMemory {
            storage: vec![0u8; storage_size],
            mt: MersenneTwister::new(seed),
            board_size,
            i_orig: 0,
            j_orig: 0,
            orientation: 0,
            next_cycles: 0,
            next_rnd: 0,
            undo_history: Some(HashMap::new()),
        };
        mem.sample_next_move();
        mem
    }

    #[inline]
    pub fn storage_size(&self) -> usize {
        self.board_size * self.board_size * M
    }

    #[inline]
    pub fn wrap_coord(&self, k: i32) -> usize {
        ((k + self.board_size as i32) as usize) % self.board_size
    }

    #[inline]
    pub fn ij_to_cell_index(&self, i: usize, j: usize) -> usize {
        j + self.board_size * i
    }

    #[inline]
    pub fn ijb_to_byte_index(&self, i: usize, j: usize, b: usize) -> usize {
        M * self.ij_to_cell_index(i, j) + b
    }

    pub fn ijb_from_byte_index(&self, byte_idx: usize) -> (usize, usize, usize) {
        let b = byte_idx % M;
        let ij = byte_idx / M;
        let j = ij % self.board_size;
        let i = ij / self.board_size;
        (i, j, b)
    }

    /// Convert a neighborhood cell index (0-48) to a storage byte offset (base address).
    pub fn neighbor_cell_storage_base(&self, neigh_idx: usize) -> usize {
        let unrotated = self.unrotate(neigh_idx);
        let spiral = &*SPIRAL;
        let (x, y) = spiral[unrotated];
        let i = self.wrap_coord(self.i_orig as i32 + x);
        let j = self.wrap_coord(self.j_orig as i32 + y);
        M * self.ij_to_cell_index(i, j)
    }

    // --- Byte access ---
    #[inline]
    pub fn get_byte(&self, idx: usize) -> u8 {
        self.storage[idx]
    }

    #[inline]
    pub fn set_byte_without_undo(&mut self, idx: usize, val: u8) {
        self.storage[idx] = val;
    }

    #[inline]
    pub fn set_byte_with_undo(&mut self, idx: usize, val: u8) {
        if let Some(ref mut history) = self.undo_history {
            history.entry(idx).or_insert_with(|| self.storage[idx]);
        }
        self.storage[idx] = val;
    }

    pub fn undo_writes(&mut self) {
        if let Some(history) = self.undo_history.take() {
            for (addr, val) in history {
                self.storage[addr] = val;
            }
        }
        self.undo_history = Some(HashMap::new());
    }

    pub fn reset_undo_history(&mut self) {
        self.undo_history = Some(HashMap::new());
    }

    pub fn disable_undo_history(&mut self) {
        self.undo_history = None;
    }

    /// Iterate over undo history keys (byte indices that were written).
    pub fn undo_history_keys(&self) -> Vec<usize> {
        match &self.undo_history {
            Some(h) => h.keys().copied().collect(),
            None => Vec::new(),
        }
    }

    // --- Rotation ---
    #[inline]
    pub fn rotate(&self, n: usize) -> usize {
        ROTATION_TABLE[self.orientation][n] as usize
    }

    #[inline]
    pub fn unrotate(&self, n: usize) -> usize {
        INV_ROTATION_TABLE[self.orientation][n] as usize
    }

    #[inline]
    fn rotate_top_bits(&self, val: u8) -> u8 {
        (val & 3) | ((self.rotate((val >> 2) as usize) as u8) << 2)
    }

    #[inline]
    fn unrotate_top_bits(&self, val: u8) -> u8 {
        (val & 3) | ((self.unrotate((val >> 2) as usize) as u8) << 2)
    }

    #[inline]
    fn addr_is_in_vector_range(addr: u16) -> bool {
        let b = (addr as usize) & BYTE_OFFSET_MASK;
        b >= FIRST_VECTOR_ADDR && b <= LAST_VECTOR_ADDR
    }

    #[inline]
    fn val_is_in_vector_range(val: u8) -> bool {
        ((val >> 2) & 0x3F) <= 48
    }

    #[inline]
    fn do_rotate_top_bits(addr: u16, val: u8) -> bool {
        Self::addr_is_in_vector_range(addr) && Self::val_is_in_vector_range(val)
    }

    // --- Address translation ---
    fn addr_to_byte_index(&self, addr: u16) -> Option<usize> {
        let addr = addr as usize;
        if addr >= N_SQUARED * M {
            return None;
        }
        let b = addr & BYTE_OFFSET_MASK;
        let cell_idx = addr >> LOG2_M;
        let spiral = &*SPIRAL;
        let unrotated = self.unrotate(cell_idx);
        if unrotated >= 49 {
            return None;
        }
        let (x, y) = spiral[unrotated];
        let i = self.wrap_coord(self.i_orig as i32 + x);
        let j = self.wrap_coord(self.j_orig as i32 + y);
        Some(self.ijb_to_byte_index(i, j, b))
    }

    // --- Memory-mapped read/write ---
    pub fn read(&self, addr: u16) -> u8 {
        let a = addr as usize;
        // ROM lookup tables
        if a >= FIRST_LOOKUP_TABLE_ADDR && a <= LAST_LOOKUP_TABLE_ADDR {
            let n_row = (a - FIRST_LOOKUP_TABLE_ADDR) >> 6;
            let n_col = a & 63;
            let table = &*TRANSFORM_TABLE;
            if n_row < table.len() && n_col < 64 {
                return table[n_row][n_col];
            }
            return 0;
        }
        // RAM
        match self.addr_to_byte_index(addr) {
            Some(idx) => {
                let val = self.storage[idx];
                if Self::do_rotate_top_bits(addr, val) {
                    self.rotate_top_bits(val)
                } else {
                    val
                }
            }
            None => 0,
        }
    }

    pub fn write(&mut self, addr: u16, val: u8) {
        if let Some(idx) = self.addr_to_byte_index(addr) {
            let stored = if Self::do_rotate_top_bits(addr, val) {
                self.unrotate_top_bits(val)
            } else {
                val
            };
            self.set_byte_with_undo(idx, stored);
        }
    }

    // --- Random sampling ---
    pub fn sample_next_move(&mut self) {
        let rv1 = self.mt.int();
        let rv2 = self.mt.int();
        let rv3 = self.mt.real();
        let rv4 = self.mt.int();

        self.i_orig = (rv1 as usize) % self.board_size;
        self.j_orig = (((rv1 >> 8) & 0xFFFF) as usize) % self.board_size;
        self.orientation = ((rv1 >> 16) & 3) as usize;

        let half_life: f64 = 177.0;
        let cycle_multiplier: f64 = 16.0;
        let mut r = rv2;
        let mut n_half_lives: u32 = 0;
        while n_half_lives < 32 && (r & 1) != 0 {
            r >>= 1;
            n_half_lives += 1;
        }
        self.next_cycles =
            (cycle_multiplier * half_life * (n_half_lives as f64 + rv3)).ceil() as u32;
        self.next_rnd = rv4;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_board_memory() {
        let mem = BoardMemory::new(42, 8);
        assert_eq!(mem.storage.len(), 8 * 8 * 1024);
        assert_eq!(mem.board_size, 8);
    }

    #[test]
    fn test_ij_roundtrip() {
        let mem = BoardMemory::new(42, 16);
        for i in 0..16 {
            for j in 0..16 {
                let idx = mem.ijb_to_byte_index(i, j, 0x42);
                let (ri, rj, rb) = mem.ijb_from_byte_index(idx);
                assert_eq!((ri, rj, rb), (i, j, 0x42));
            }
        }
    }

    #[test]
    fn test_wrap_coord() {
        let mem = BoardMemory::new(42, 8);
        assert_eq!(mem.wrap_coord(-1), 7);
        assert_eq!(mem.wrap_coord(8), 0);
        assert_eq!(mem.wrap_coord(3), 3);
    }

    #[test]
    fn test_undo_writes() {
        let mut mem = BoardMemory::new(42, 8);
        let idx = mem.ijb_to_byte_index(0, 0, 0);
        mem.storage[idx] = 0xAA;
        mem.reset_undo_history();
        mem.set_byte_with_undo(idx, 0xBB);
        assert_eq!(mem.storage[idx], 0xBB);
        mem.undo_writes();
        assert_eq!(mem.storage[idx], 0xAA);
    }

    #[test]
    fn test_read_write_ram() {
        let mut mem = BoardMemory::new(42, 8);
        // Write to address 0x0200 (cell 0, byte 0x200 — outside vector range)
        mem.write(0x0200, 0x42);
        assert_eq!(mem.read(0x0200), 0x42);
    }

    #[test]
    fn test_read_rom_lookup() {
        let mem = BoardMemory::new(42, 8);
        // ROM at 0xE000 should return transform table values
        let val = mem.read(0xE000);
        // First row, first col of transform table = translate by spiral[0]=(0,0) applied to spiral[0]=(0,0) = cell index 0
        assert_eq!(val, 0);
    }

    #[test]
    fn test_sample_next_move_deterministic() {
        let mut mem1 = BoardMemory::new(42, 256);
        let mut mem2 = BoardMemory::new(42, 256);
        // After construction, both should have sampled the same first move
        assert_eq!(mem1.i_orig, mem2.i_orig);
        assert_eq!(mem1.j_orig, mem2.j_orig);
        assert_eq!(mem1.orientation, mem2.orientation);
        assert_eq!(mem1.next_cycles, mem2.next_cycles);
        // Sample again
        mem1.sample_next_move();
        mem2.sample_next_move();
        assert_eq!(mem1.i_orig, mem2.i_orig);
        assert_eq!(mem1.next_cycles, mem2.next_cycles);
    }

    #[test]
    fn test_neighbor_cell_storage_base() {
        let mem = BoardMemory::new(42, 8);
        // Cell 0 should be the origin cell
        let base0 = mem.neighbor_cell_storage_base(0);
        let expected = M * mem.ij_to_cell_index(mem.i_orig, mem.j_orig);
        assert_eq!(base0, expected);
    }
}
