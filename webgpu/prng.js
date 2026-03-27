/**
 * Seeded PRNG (mulberry32). Fast, deterministic, portable.
 * Used for scheduling so board histories are reproducible.
 */
export class PRNG {
    constructor(seed = 42) {
        this._state = seed >>> 0;
    }

    // Returns uint32
    int() {
        let t = (this._state += 0x6D2B79F5) >>> 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0);
    }

    // Returns [0, 1)
    real() {
        return this.int() / 4294967296;
    }

    // Returns int in [0, max)
    below(max) {
        return this.int() % max;
    }

    // Serialize state
    get state() { return this._state; }
    set state(s) { this._state = s >>> 0; }
}
