//! 6502life WASM engine — Rust port of the core board simulation.
//!
//! Exposes `WasmBoard` to JavaScript via wasm-bindgen, providing:
//! - Board creation with deterministic seeding
//! - `run_to_next_interrupt()` — advance simulation one scheduling quantum
//! - Direct memory access via `memory_ptr()` for zero-copy JS reads
//! - `overview_pixel_buffer()` — RGBA pixel buffer for visualization

mod controller;
mod cpu;
mod memory;
mod mt;
mod tables;

use controller::{BoardController, BoardParams};
use memory::BoardMemory;
use wasm_bindgen::prelude::*;

/// Main WASM-exposed board handle.
#[wasm_bindgen]
pub struct WasmBoard {
    controller: BoardController,
}

#[wasm_bindgen]
impl WasmBoard {
    /// Create a new board with the given size and RNG seed.
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize, seed: u32) -> WasmBoard {
        let memory = BoardMemory::new(seed, size);
        let controller = BoardController::new(memory);
        WasmBoard { controller }
    }

    /// Create a new board with full board params.
    pub fn new_with_params(
        size: usize,
        seed: u32,
        p_bit_noise: f64,
        p_brk_failure: f64,
        magnetosensing: bool,
        implements_move: bool,
        implements_copy: bool,
        implements_sync: bool,
        implements_async: bool,
    ) -> WasmBoard {
        let memory = BoardMemory::new(seed, size);
        let params = BoardParams {
            p_bit_noise,
            p_brk_failure,
            magnetosensing,
            implements_move,
            implements_copy,
            implements_sync,
            implements_async,
        };
        let controller = BoardController::with_params(memory, params);
        WasmBoard { controller }
    }

    // --- Board params getters/setters ---

    pub fn get_p_bit_noise(&self) -> f64 {
        self.controller.board_params.p_bit_noise
    }

    pub fn set_p_bit_noise(&mut self, val: f64) {
        self.controller.board_params.p_bit_noise = val;
    }

    pub fn get_p_brk_failure(&self) -> f64 {
        self.controller.board_params.p_brk_failure
    }

    pub fn set_p_brk_failure(&mut self, val: f64) {
        self.controller.board_params.p_brk_failure = val;
    }

    pub fn get_magnetosensing(&self) -> bool {
        self.controller.board_params.magnetosensing
    }

    pub fn set_magnetosensing(&mut self, val: bool) {
        self.controller.board_params.magnetosensing = val;
    }

    pub fn get_implements_move(&self) -> bool {
        self.controller.board_params.implements_move
    }

    pub fn set_implements_move(&mut self, val: bool) {
        self.controller.board_params.implements_move = val;
    }

    pub fn get_implements_copy(&self) -> bool {
        self.controller.board_params.implements_copy
    }

    pub fn set_implements_copy(&mut self, val: bool) {
        self.controller.board_params.implements_copy = val;
    }

    pub fn get_implements_sync(&self) -> bool {
        self.controller.board_params.implements_sync
    }

    pub fn set_implements_sync(&mut self, val: bool) {
        self.controller.board_params.implements_sync = val;
    }

    pub fn get_implements_async(&self) -> bool {
        self.controller.board_params.implements_async
    }

    pub fn set_implements_async(&mut self, val: bool) {
        self.controller.board_params.implements_async = val;
    }

    /// Board dimension (cells per side).
    pub fn size(&self) -> usize {
        self.controller.board_size()
    }

    /// Total bytes in storage (size * size * 1024).
    pub fn storage_size(&self) -> usize {
        self.controller.memory.storage_size()
    }

    /// Pointer to the raw storage buffer (for zero-copy access from JS).
    pub fn memory_ptr(&self) -> *const u8 {
        self.controller.memory.storage.as_ptr()
    }

    /// Total elapsed CPU cycles.
    pub fn total_cycles(&self) -> u64 {
        self.controller.total_cycles
    }

    /// Fill storage with random data.
    pub fn randomize(&mut self) {
        self.controller.randomize();
    }

    /// Run simulation until the next interrupt. Returns scheduler_cycles.
    pub fn run_to_next_interrupt(&mut self) -> u32 {
        let result = self.controller.run_to_next_interrupt();
        result.scheduler_cycles
    }

    /// Run N interrupts. Returns total scheduler cycles consumed.
    pub fn run_interrupts(&mut self, count: u32) -> u64 {
        let mut total: u64 = 0;
        for _ in 0..count {
            let result = self.controller.run_to_next_interrupt();
            total += result.scheduler_cycles as u64;
        }
        total
    }

    /// Read a single byte from the board storage at absolute index.
    pub fn get_byte(&self, idx: usize) -> u8 {
        self.controller.memory.get_byte(idx)
    }

    /// Write a single byte to storage at absolute index (no undo tracking).
    pub fn set_byte(&mut self, idx: usize, val: u8) {
        self.controller.memory.set_byte_without_undo(idx, val);
    }

    /// Get the last write time for a cell (linear index).
    pub fn last_write_time(&self, cell_idx: usize) -> u64 {
        self.controller.last_write_time[cell_idx]
    }

    /// Get the last move time for a cell (linear index).
    pub fn last_move_time(&self, cell_idx: usize) -> u64 {
        self.controller.last_move_time[cell_idx]
    }

    /// Generate an RGBA overview pixel buffer (1 pixel per cell).
    /// Returns a Vec<u8> of size * size * 4 bytes.
    pub fn overview_pixel_buffer(&self) -> Vec<u8> {
        let size = self.controller.board_size();
        let total = self.controller.total_cycles as f64;
        let mut buf = vec![0u8; size * size * 4];

        for i in 0..size {
            for j in 0..size {
                let cell_idx = j + size * i;
                let tw = total - self.controller.last_write_time[cell_idx] as f64;
                let tm = total - self.controller.last_move_time[cell_idx] as f64;

                // HSV color computation matching board/visualizer.js
                let write_decay = 100.0;
                let move_decay = 10.0;
                let s_write_prop = 0.4;
                let v_write_prop = 0.8;

                let sat = s_write_prop * (-tw / write_decay).exp()
                    + (1.0 - s_write_prop) * (-tm / move_decay).exp();
                let val = v_write_prop * (-tw / write_decay).exp()
                    + (1.0 - v_write_prop) * (-tm / move_decay).exp();

                // Fixed hue = 1/3 (green), convert HSV to RGB
                let hue = 1.0 / 3.0;
                let (r, g, b) = hsv_to_rgb(hue, sat.min(1.0), val.min(1.0));

                let offset = cell_idx * 4;
                buf[offset] = (r * 255.0) as u8;
                buf[offset + 1] = (g * 255.0) as u8;
                buf[offset + 2] = (b * 255.0) as u8;
                buf[offset + 3] = 255;
            }
        }
        buf
    }

    /// Write assembled bytes into a cell's storage.
    pub fn write_cell_bytes(&mut self, i: usize, j: usize, start_byte: usize, data: &[u8]) {
        let base = self.controller.memory.ijb_to_byte_index(i, j, start_byte);
        for (offset, &byte) in data.iter().enumerate() {
            if start_byte + offset < 1024 {
                self.controller
                    .memory
                    .set_byte_without_undo(base + offset, byte);
            }
        }
    }

    /// Get the lastWriter for a cell (linear index).
    pub fn get_last_writer(&self, cell_idx: usize) -> String {
        self.controller.last_writer[cell_idx].clone()
    }

    /// Set the board owner wallet ID.
    pub fn set_board_owner(&mut self, id: String) {
        self.controller.board_owner = id;
    }

    /// Read a cell's 32-byte display name as a String.
    pub fn cell_name(&self, i: usize, j: usize) -> String {
        let base = self.controller.memory.ijb_to_byte_index(i, j, 0x3E0);
        let mut name = Vec::with_capacity(32);
        for offset in 0..32 {
            let b = self.controller.memory.storage[base + offset];
            if b == 0 {
                break;
            }
            name.push(b);
        }
        String::from_utf8_lossy(&name).into_owned()
    }
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    if s <= 0.0 {
        return (v, v, v);
    }
    let hh = (h * 6.0) % 6.0;
    let i = hh as u32;
    let ff = hh - i as f64;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * ff);
    let t = v * (1.0 - s * (1.0 - ff));
    match i {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasm_board_creation() {
        let board = WasmBoard::new(8, 42);
        assert_eq!(board.size(), 8);
        assert_eq!(board.storage_size(), 8 * 8 * 1024);
        assert_eq!(board.total_cycles(), 0);
    }

    #[test]
    fn test_wasm_board_run() {
        let mut board = WasmBoard::new(8, 42);
        let cycles = board.run_to_next_interrupt();
        assert!(cycles > 0);
        assert!(board.total_cycles() > 0);
    }

    #[test]
    fn test_wasm_board_run_interrupts() {
        let mut board = WasmBoard::new(8, 42);
        let total = board.run_interrupts(100);
        assert!(total > 0);
        assert!(board.total_cycles() > 0);
    }

    #[test]
    fn test_wasm_board_randomize() {
        let mut board = WasmBoard::new(8, 42);
        board.randomize();
        let non_zero = (0..board.storage_size())
            .filter(|&i| board.get_byte(i) != 0)
            .count();
        assert!(non_zero > 0);
    }

    #[test]
    fn test_wasm_board_pixel_buffer() {
        let mut board = WasmBoard::new(4, 42);
        board.run_interrupts(10);
        let buf = board.overview_pixel_buffer();
        assert_eq!(buf.len(), 4 * 4 * 4); // 4x4 board, RGBA
        // Alpha should always be 255
        for i in (3..buf.len()).step_by(4) {
            assert_eq!(buf[i], 255);
        }
    }

    #[test]
    fn test_wasm_board_write_cell_bytes() {
        let mut board = WasmBoard::new(8, 42);
        let data = vec![0xA9, 0x42, 0x85, 0x10]; // LDA #$42; STA $10
        board.write_cell_bytes(0, 0, 0, &data);
        for (i, &byte) in data.iter().enumerate() {
            assert_eq!(board.get_byte(i), byte);
        }
    }

    #[test]
    fn test_hsv_to_rgb() {
        // Pure green at full saturation/value
        let (r, g, b) = hsv_to_rgb(1.0 / 3.0, 1.0, 1.0);
        assert!((r - 0.0).abs() < 0.01);
        assert!((g - 1.0).abs() < 0.01);
        assert!((b - 0.0).abs() < 0.01);

        // Zero saturation should be gray
        let (r, g, b) = hsv_to_rgb(0.0, 0.0, 0.5);
        assert!((r - 0.5).abs() < 0.01);
        assert!((g - 0.5).abs() < 0.01);
        assert!((b - 0.5).abs() < 0.01);
    }
}
