/// Precomputed lookup tables for the 7x7 spiral neighborhood mapping.
/// These mirror the JavaScript `spiralSortedCellVec`, rotation tables,
/// and transform lookup tables from board/memory.js.

use std::f64::consts::PI;

/// A 2D vector (dx, dy) for neighborhood offsets.
pub type Vec2 = (i32, i32);

/// The 49 cells in spiral order (taxicab distance, then max-delta, then angle).
/// Index 0 = origin (0,0), then N, E, S, W, NE, SE, ...
pub static SPIRAL: once_cell::sync::Lazy<[Vec2; 49]> = once_cell::sync::Lazy::new(compute_spiral);

fn compute_spiral() -> [Vec2; 49] {
    let mut vecs: Vec<Vec2> = Vec::with_capacity(49);
    for x in -3..=3i32 {
        for y in -3..=3i32 {
            vecs.push((x, y));
        }
    }
    vecs.sort_by(|a, b| {
        let ta = taxicab(*a);
        let tb = taxicab(*b);
        ta.cmp(&tb)
            .then_with(|| max_delta(*a).cmp(&max_delta(*b)))
            .then_with(|| angle(*a).partial_cmp(&angle(*b)).unwrap())
    });
    let mut arr = [(0i32, 0i32); 49];
    for (i, v) in vecs.iter().enumerate() {
        arr[i] = *v;
    }
    arr
}

fn taxicab(v: Vec2) -> i32 {
    v.0.abs() + v.1.abs()
}

fn max_delta(v: Vec2) -> i32 {
    v.0.abs().max(v.1.abs())
}

fn pos_angle(a: f64) -> f64 {
    if a < 0.0 { a + 2.0 * PI } else { a }
}

fn angle(v: Vec2) -> f64 {
    // Note: JS uses atan2(x, y) to get N=0 NESW ordering
    pos_angle((v.0 as f64).atan2(v.1 as f64))
}

/// Cell index: maps (dx, dy) where dx,dy in [-3,3] to spiral index.
/// Returns index | 128 if out of range.
pub fn lookup_cell_index(v: Vec2) -> u8 {
    let spiral = &*SPIRAL;
    let x = ((v.0 + 3 + 14) % 7) as usize;
    let y = ((v.1 + 3 + 14) % 7) as usize;
    // Find the spiral index for this wrapped coordinate
    for (idx, s) in spiral.iter().enumerate() {
        if (s.0 + 3) as usize == x && (s.1 + 3) as usize == y {
            let oob = if max_delta(v) > 3 { 128 } else { 0 };
            return (idx as u8) | oob;
        }
    }
    128 // out of bounds
}

fn rotate1(xy: Vec2) -> Vec2 {
    (xy.1, -xy.0)
}
fn rotate2(xy: Vec2) -> Vec2 {
    rotate1(rotate1(xy))
}
fn rotate3(xy: Vec2) -> Vec2 {
    rotate1(rotate2(xy))
}
fn reflect_x(xy: Vec2) -> Vec2 {
    (xy.0, -xy.1)
}
fn reflect_y(xy: Vec2) -> Vec2 {
    rotate3(reflect_x(rotate1(xy)))
}

/// Rotation lookup tables: rotation_table[orientation][cell_index] -> rotated cell index
pub static ROTATION_TABLE: once_cell::sync::Lazy<[[u8; 49]; 4]> =
    once_cell::sync::Lazy::new(|| {
        let spiral = &*SPIRAL;
        let rotations: [fn(Vec2) -> Vec2; 4] = [|xy| xy, rotate1, rotate2, rotate3];
        let mut table = [[0u8; 49]; 4];
        for (r, rot_fn) in rotations.iter().enumerate() {
            for (n, sv) in spiral.iter().enumerate() {
                table[r][n] = lookup_cell_index(rot_fn(*sv));
            }
        }
        table
    });

/// Inverse rotation lookup tables
pub static INV_ROTATION_TABLE: once_cell::sync::Lazy<[[u8; 49]; 4]> =
    once_cell::sync::Lazy::new(|| {
        let spiral = &*SPIRAL;
        let inv_rotations: [fn(Vec2) -> Vec2; 4] = [|xy| xy, rotate3, rotate2, rotate1];
        let mut table = [[0u8; 49]; 4];
        for (r, rot_fn) in inv_rotations.iter().enumerate() {
            for (n, sv) in spiral.iter().enumerate() {
                table[r][n] = lookup_cell_index(rot_fn(*sv));
            }
        }
        table
    });

/// Full transform lookup table (used at ROM addresses 0xE000-0xEFFF).
/// Rows 0..48 = translate by spiral[i], rows 49..51 = rotate 1/2/3,
/// rows 52 = reflectX, 53 = reflectY, rows 54 = xCoords, 55 = yCoords,
/// row 56 = coordLookupTable.
pub static TRANSFORM_TABLE: once_cell::sync::Lazy<Vec<[u8; 64]>> =
    once_cell::sync::Lazy::new(|| {
        let spiral = &*SPIRAL;
        let mut rows: Vec<[u8; 64]> = Vec::new();

        // Rows 0..49: translate by each spiral vector
        for sv in spiral.iter() {
            let mut row = [0u8; 64];
            for (n, sv2) in spiral.iter().enumerate() {
                let translated = (sv.0 + sv2.0, sv.1 + sv2.1);
                row[n] = lookup_cell_index(translated);
            }
            rows.push(row);
        }

        // Rows 49..52: rotations 1, 2, 3
        let rot_fns: [fn(Vec2) -> Vec2; 3] = [rotate1, rotate2, rotate3];
        for rot_fn in rot_fns.iter() {
            let mut row = [0u8; 64];
            for (n, sv) in spiral.iter().enumerate() {
                row[n] = lookup_cell_index(rot_fn(*sv));
            }
            rows.push(row);
        }

        // Row 52: reflectX, Row 53: reflectY
        let ref_fns: [fn(Vec2) -> Vec2; 2] = [reflect_x, reflect_y];
        for ref_fn in ref_fns.iter() {
            let mut row = [0u8; 64];
            for (n, sv) in spiral.iter().enumerate() {
                row[n] = lookup_cell_index(ref_fn(*sv));
            }
            rows.push(row);
        }

        // Row 54: xCoords (spiral[i].0 + 3)
        {
            let mut row = [0u8; 64];
            for (n, sv) in spiral.iter().enumerate() {
                row[n] = (sv.0 + 3) as u8;
            }
            rows.push(row);
        }

        // Row 55: yCoords (spiral[i].1 + 3)
        {
            let mut row = [0u8; 64];
            for (n, sv) in spiral.iter().enumerate() {
                row[n] = (sv.1 + 3) as u8;
            }
            rows.push(row);
        }

        // Row 56: coordLookupTable (8x8 grid, -1 for edges)
        {
            let mut row = [0u8; 64];
            for n in 0..64usize {
                let col = n % 8;
                let r = n / 8;
                if col == 7 || r == 7 {
                    row[n] = 0xFF; // -1 as u8
                } else {
                    let v = ((col as i32) - 3, (r as i32) - 3);
                    row[n] = lookup_cell_index(v);
                }
            }
            rows.push(row);
        }

        rows
    });

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spiral_origin_is_zero() {
        let spiral = &*SPIRAL;
        assert_eq!(spiral[0], (0, 0));
    }

    #[test]
    fn test_spiral_has_49_entries() {
        assert_eq!(SPIRAL.len(), 49);
    }

    #[test]
    fn test_spiral_sorted_by_taxicab() {
        let spiral = &*SPIRAL;
        for i in 1..49 {
            assert!(taxicab(spiral[i]) >= taxicab(spiral[i - 1]));
        }
    }

    #[test]
    fn test_rotation_table_identity() {
        let table = &*ROTATION_TABLE;
        // Rotation 0 should be identity
        for i in 0..49 {
            assert_eq!(table[0][i], i as u8);
        }
    }

    #[test]
    fn test_rotation_inverse() {
        let rot = &*ROTATION_TABLE;
        let inv = &*INV_ROTATION_TABLE;
        for o in 0..4 {
            for i in 0..49 {
                let rotated = rot[o][i] as usize;
                if rotated < 49 {
                    assert_eq!(inv[o][rotated] as usize, i);
                }
            }
        }
    }

    #[test]
    fn test_transform_table_row_count() {
        let table = &*TRANSFORM_TABLE;
        // 49 translations + 3 rotations + 2 reflections + 2 coord rows + 1 coord lookup = 57
        assert_eq!(table.len(), 57);
    }
}
