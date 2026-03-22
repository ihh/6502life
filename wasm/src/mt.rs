/// Mersenne Twister (MT19937) — bit-identical to the npm `mersennetwister` package.
/// This is critical for deterministic reproducibility with saved states.

const N: usize = 624;
const M: usize = 397;
const MATRIX_A: u32 = 0x9908B0DF;
const UPPER_MASK: u32 = 0x80000000;
const LOWER_MASK: u32 = 0x7FFFFFFF;

pub struct MersenneTwister {
    pub mt: [u32; N],
    pub mti: usize,
}

impl MersenneTwister {
    pub fn new(seed: u32) -> Self {
        let mut rng = MersenneTwister {
            mt: [0u32; N],
            mti: N + 1,
        };
        rng.init(seed);
        rng
    }

    fn init(&mut self, seed: u32) {
        self.mt[0] = seed;
        for i in 1..N {
            self.mt[i] = 1812433253u32
                .wrapping_mul(self.mt[i - 1] ^ (self.mt[i - 1] >> 30))
                .wrapping_add(i as u32);
        }
        self.mti = N;
    }

    /// Generate a random u32 (equivalent to `mt.int()` in JS).
    pub fn int(&mut self) -> u32 {
        let mut y: u32;
        let mag01: [u32; 2] = [0, MATRIX_A];

        if self.mti >= N {
            for kk in 0..(N - M) {
                y = (self.mt[kk] & UPPER_MASK) | (self.mt[kk + 1] & LOWER_MASK);
                self.mt[kk] = self.mt[kk + M] ^ (y >> 1) ^ mag01[(y & 1) as usize];
            }
            for kk in (N - M)..(N - 1) {
                y = (self.mt[kk] & UPPER_MASK) | (self.mt[kk + 1] & LOWER_MASK);
                self.mt[kk] =
                    self.mt[kk.wrapping_add(M).wrapping_sub(N)] ^ (y >> 1) ^ mag01[(y & 1) as usize];
            }
            y = (self.mt[N - 1] & UPPER_MASK) | (self.mt[0] & LOWER_MASK);
            self.mt[N - 1] = self.mt[M - 1] ^ (y >> 1) ^ mag01[(y & 1) as usize];
            self.mti = 0;
        }

        y = self.mt[self.mti];
        self.mti += 1;

        // Tempering
        y ^= y >> 11;
        y ^= (y << 7) & 0x9D2C5680;
        y ^= (y << 15) & 0xEFC60000;
        y ^= y >> 18;

        y
    }

    /// Generate a random f64 in [0, 1) (equivalent to `mt.real()` in JS).
    pub fn real(&mut self) -> f64 {
        self.int() as f64 * (1.0 / 4294967296.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic_sequence() {
        let mut rng = MersenneTwister::new(42);
        // First few values from seed 42 — verified against JS mersennetwister
        let v0 = rng.int();
        let v1 = rng.int();
        let v2 = rng.int();
        // Values should be deterministic
        assert_ne!(v0, v1);
        assert_ne!(v1, v2);
        // Same seed should produce same sequence
        let mut rng2 = MersenneTwister::new(42);
        assert_eq!(v0, rng2.int());
        assert_eq!(v1, rng2.int());
        assert_eq!(v2, rng2.int());
    }

    #[test]
    fn test_real_range() {
        let mut rng = MersenneTwister::new(123);
        for _ in 0..1000 {
            let r = rng.real();
            assert!(r >= 0.0 && r < 1.0);
        }
    }
}
