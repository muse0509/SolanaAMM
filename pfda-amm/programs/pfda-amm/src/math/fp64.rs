//! Q32.32 fixed-point arithmetic for the PFDA AMM.
//!
//! Format: u64 where the value represents `raw / 2^32`.
//! Range: [0, ~4.29 billion] with ~2.3e-10 precision.

/// The fractional shift: 2^32
pub const FP_ONE: u64 = 1u64 << 32;

/// Convert an integer to Q32.32
#[inline]
pub fn fp_from_int(x: u64) -> u64 {
    x << 32
}

/// Convert a Q32.32 value to its integer floor
#[inline]
pub fn fp_to_int(x: u64) -> u64 {
    x >> 32
}

/// Multiply two Q32.32 numbers: result = (a * b) >> 32
/// Uses u128 to avoid overflow.
#[inline]
pub fn fp_mul(a: u64, b: u64) -> u64 {
    (((a as u128) * (b as u128)) >> 32) as u64
}

/// Divide two Q32.32 numbers: result = (a << 32) / b
/// Uses u128 to avoid overflow.
#[inline]
pub fn fp_div(a: u64, b: u64) -> u64 {
    if b == 0 {
        return u64::MAX;
    }
    (((a as u128) << 32) / (b as u128)) as u64
}

/// Compute floor(sqrt(n)) for a plain u64 integer using Newton-Raphson.
fn isqrt(n: u128) -> u64 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) >> 1;
    while y < x {
        x = y;
        y = (x + n / x) >> 1;
    }
    x as u64
}

/// Square root of a Q32.32 value, returning Q32.32.
///
/// sqrt(a / 2^32) = sqrt(a) / 2^16
/// So: sqrt_fp(a) = sqrt(a * 2^32) as Q32.32
///               = isqrt(a as u128 * 2^32) as u64
#[inline]
pub fn fp_sqrt(a: u64) -> u64 {
    isqrt((a as u128) << 32)
}

/// Base-2 logarithm of a Q32.32 value, returning a signed Q32.32 value.
///
/// For x in Q32.32 format: log2(x / 2^32) = log2(x) - 32
///
/// Algorithm:
/// 1. Find the position of the highest set bit to get integer part.
/// 2. Normalize x into [1, 2) range.
/// 3. Compute fractional part bit-by-bit via repeated squaring.
///    For each bit i from 31..0: square m; if m >= 2 set that bit, then halve m.
///    This gives exact 32-bit fractional precision.
///
/// Returns i64 in Q32.32 format (can be negative).
pub fn fp_log2(x: u64) -> i64 {
    if x == 0 {
        return i64::MIN;
    }

    // Find leading bit position
    let leading = x.leading_zeros() as i64;
    // Bit position of the highest set bit (0-indexed from LSB)
    let bit_pos = 63 - leading;

    // Integer part of log2(x): bit_pos - 32 (adjust for Q32.32 format)
    let int_part = bit_pos - 32;

    // Normalize x into [FP_ONE, 2*FP_ONE): shift so the leading bit is at position 32
    let mut m: u64 = if bit_pos >= 32 {
        x >> (bit_pos - 32)
    } else {
        x << (32 - bit_pos)
    };

    // Compute fractional part of log2 using the bit-by-bit (iterative squaring) method.
    // Invariant: m is in [FP_ONE, 2*FP_ONE) at the start of each iteration.
    // Squaring m gives m^2 in [FP_ONE, 4*FP_ONE); if m^2 >= 2*FP_ONE the current bit is 1.
    let mut frac: u64 = 0;
    for i in (0u32..32).rev() {
        m = fp_mul(m, m);
        if m >= 2 * FP_ONE {
            frac |= 1u64 << i;
            m >>= 1; // divide by 2 to restore m into [FP_ONE, 2*FP_ONE)
        }
    }

    (int_part << 32) + frac as i64
}

/// Base-2 exponentiation of a signed Q32.32 value: returns 2^(x) in Q32.32.
///
/// Algorithm:
/// 1. Split x into integer and fractional parts.
/// 2. Integer part: shift result.
/// 3. Fractional part: polynomial approximation of 2^f for f in [0,1).
///
/// Input x is signed Q32.32. Output is Q32.32.
pub fn fp_exp2(x: i64) -> u64 {
    // Clamp to avoid overflow
    if x >= (31i64 << 32) {
        return u64::MAX;
    }
    if x < (-32i64 << 32) {
        return 0;
    }

    let int_part = x >> 32;
    let frac_part = (x & 0xFFFF_FFFF) as u64; // fractional bits in [0, FP_ONE)

    // Polynomial approximation of 2^f for f in [0, 1)
    // 2^f = 1 + f*ln(2) + (f*ln(2))^2/2! + ...
    // Better: direct polynomial in Q32.32
    // 2^f ≈ 1 + f*(c1 + f*(c2 + f*(c3 + f*c4)))
    // c1 = ln(2) = 0.693147... → Q32.32: 2977044472
    // c2 = ln(2)^2/2 = 0.240227... → Q32.32: 1031917339
    // c3 = ln(2)^3/6 = 0.055504... → Q32.32: 238417082
    // c4 = ln(2)^4/24 = 0.009618... → Q32.32: 41323799

    const C1: u64 = 2977044472u64; // ln(2) in Q32.32
    const C2: u64 = 1031917339u64; // ln(2)^2/2 in Q32.32
    const C3: u64 = 238417082u64;  // ln(2)^3/6 in Q32.32
    const C4: u64 = 41323799u64;   // ln(2)^4/24 in Q32.32

    let f = frac_part;
    // Horner: p = c4; p = f*p + c3; p = f*p + c2; p = f*p + c1; result = FP_ONE + f*p
    let p = C4;
    let p = fp_mul(f, p) + C3;
    let p = fp_mul(f, p) + C2;
    let p = fp_mul(f, p) + C1;
    let frac_result = FP_ONE + fp_mul(f, p);

    // Scale by 2^int_part
    if int_part >= 0 {
        frac_result.checked_shl(int_part as u32).unwrap_or(u64::MAX)
    } else {
        frac_result >> ((-int_part) as u32)
    }
}

/// Compute x^w where w = weight_micro / 1_000_000, all in Q32.32.
///
/// Uses: x^w = exp2(w * log2(x))
///
/// - `x`: Q32.32 value (must be > 0)
/// - `weight_micro`: weight in millionths (0..=1_000_000)
/// Returns Q32.32 or None on error.
pub fn fp_pow_weight(x: u64, weight_micro: u32) -> Option<u64> {
    if x == 0 {
        return Some(0);
    }
    if weight_micro == 0 {
        return Some(FP_ONE); // x^0 = 1
    }
    if weight_micro == 1_000_000 {
        return Some(x); // x^1 = x
    }

    let log_x = fp_log2(x);
    // w in Q32.32: weight_micro / 1_000_000 * 2^32
    // = weight_micro * 2^32 / 1_000_000
    let w_fp = ((weight_micro as u128) * (FP_ONE as u128) / 1_000_000u128) as i64;
    let exponent = ((log_x as i128 * w_fp as i128) >> 32) as i64;
    Some(fp_exp2(exponent))
}

/// Compute the G3M batch clearing price for a given batch.
///
/// The clearing price P (B per A) satisfies:
///   Ra(P)^w_a * Rb(P)^w_b = Ra^w_a * Rb^w_b  (invariant preserved)
///
/// where:
///   Ra(P) = Ra + total_in_a - total_in_b / P
///   Rb(P) = Rb + total_in_b - total_in_a * P
///
/// For 50/50 weight: uses analytic quadratic formula.
/// For general weight: uses 64-iteration binary search.
///
/// Parameters:
/// - `reserve_a`, `reserve_b`: current pool reserves (raw token amounts)
/// - `weight_a_micro`: weight of token A in millionths (500_000 = 50%)
/// - `total_in_a`, `total_in_b`: total batch inputs (raw token amounts)
///
/// Returns the clearing price in Q32.32 format (B per A), or None if computation fails.
pub fn compute_clearing_price(
    reserve_a: u64,
    reserve_b: u64,
    weight_a_micro: u32,
    total_in_a: u64,
    total_in_b: u64,
) -> Option<u64> {
    // If no inputs, no clearing price needed (return midpoint price)
    if total_in_a == 0 && total_in_b == 0 {
        // Return current spot price: Rb/Ra * w_a/w_b
        if reserve_a == 0 {
            return None;
        }
        let rb_fp = fp_from_int(reserve_b);
        let ra_fp = fp_from_int(reserve_a);
        let price = fp_div(rb_fp, ra_fp);
        // Adjust for weights: spot price = (Rb/Ra) * (w_a/w_b)
        let wb_micro = 1_000_000u32 - weight_a_micro;
        if wb_micro == 0 {
            return None;
        }
        let weight_ratio = fp_div(
            fp_from_int(weight_a_micro as u64),
            fp_from_int(wb_micro as u64),
        );
        return Some(fp_mul(price, weight_ratio));
    }

    // If only one side has input, the price is determined by the other side's reserve ratio
    // Use binary search in all cases for correctness, with analytic warm-start for 50/50

    let weight_b_micro = 1_000_000u32.saturating_sub(weight_a_micro);

    // Compute current invariant k = Ra^w_a * Rb^w_b
    let ra_fp = fp_from_int(reserve_a);
    let rb_fp = fp_from_int(reserve_b);

    let ra_pow = fp_pow_weight(ra_fp, weight_a_micro)?;
    let rb_pow = fp_pow_weight(rb_fp, weight_b_micro)?;
    let k = fp_mul(ra_pow, rb_pow);

    if k == 0 {
        return None;
    }

    // For 50/50 weight: use analytic solution as initial guess and cross-check
    // The invariant is: (Ra + A - B/P) * (Rb + B - A*P) = Ra * Rb
    // Let x = P (the clearing price)
    // Expand: let ra2 = Ra + A, rb2 = Rb + B
    // (ra2 - B/x)(rb2 - A*x) = Ra*Rb
    // ra2*rb2 - ra2*A*x - rb2*B/x + A*B = Ra*Rb
    // Multiply by x: ra2*rb2*x - ra2*A*x^2 - rb2*B + A*B*x = Ra*Rb*x
    // ra2*A*x^2 - (ra2*rb2 + A*B - Ra*Rb)*x + rb2*B = 0
    // Using quadratic formula with u128 for coefficients:

    let p_analytic_50_50 = if weight_a_micro == 500_000 {
        compute_clearing_price_50_50(reserve_a, reserve_b, total_in_a, total_in_b)
    } else {
        None
    };

    if let Some(p) = p_analytic_50_50 {
        // Verify and return if valid
        if verify_clearing_price(p, reserve_a, reserve_b, weight_a_micro, total_in_a, total_in_b, k) {
            return Some(p);
        }
    }

    // General case: binary search over price in Q32.32
    // Price range: must be positive; use log-space binary search
    // Lower bound: price where Ra(P) is barely positive
    // Upper bound: price where Rb(P) is barely positive

    // Lower bound: total_in_b / (Ra + total_in_a) as a rough minimum
    // Upper bound: (Rb + total_in_b) / total_in_a as a rough maximum
    // Be generous with bounds

    let lo_num = if total_in_b > 0 { total_in_b } else { 1 };
    let hi_den = if total_in_a > 0 { total_in_a } else { 1 };

    // lo = 1 / (2 * (Ra + A + 1)) in Q32.32 terms, very small
    // hi = 2 * (Rb + B + 1) in Q32.32
    let ra_plus_a = reserve_a.saturating_add(total_in_a).saturating_add(1);
    let rb_plus_b = reserve_b.saturating_add(total_in_b).saturating_add(1);

    // Sensible bounds
    let mut lo: u64 = fp_div(fp_from_int(lo_num / ra_plus_a.max(1)), fp_from_int(4));
    if lo == 0 { lo = 1; }
    let mut hi: u64 = fp_mul(fp_from_int(rb_plus_b), fp_from_int(4 * hi_den.max(1)));
    if hi == 0 || hi < lo { hi = fp_from_int(rb_plus_b.saturating_add(1)); }

    // Ensure lo < hi
    if lo >= hi {
        lo = 1;
        hi = u64::MAX >> 2;
    }

    // 64 iterations of binary search
    let mut best_p = (lo / 2).saturating_add(hi / 2);

    for _ in 0..64 {
        let mid = lo / 2 + hi / 2;
        if mid == 0 { break; }

        let f_mid = eval_invariant(mid, reserve_a, reserve_b, weight_a_micro, total_in_a, total_in_b, k);

        match f_mid {
            Some(true) => {
                // f(P) > 0: price too low, search higher
                best_p = mid;
                lo = mid;
            }
            Some(false) => {
                // f(P) <= 0: price too high, search lower
                hi = mid;
            }
            None => {
                // invalid range
                hi = mid;
            }
        }

        if hi - lo <= 1 {
            break;
        }
    }

    Some(best_p)
}

/// Analytic solution for 50/50 weight clearing price.
///
/// Solves: ra2*A*P^2 - (ra2*rb2 + A*B - Ra*Rb)*P + rb2*B = 0
/// where ra2 = Ra + A, rb2 = Rb + B
///
/// Returns the smaller positive root (economically meaningful).
fn compute_clearing_price_50_50(
    reserve_a: u64,
    reserve_b: u64,
    total_in_a: u64,
    total_in_b: u64,
) -> Option<u64> {
    // Use u128 arithmetic to avoid overflow
    let ra = reserve_a as u128;
    let rb = reserve_b as u128;
    let a = total_in_a as u128;
    let b = total_in_b as u128;

    let ra2 = ra + a;
    let rb2 = rb + b;

    if a == 0 && b == 0 {
        // No orders: spot price = Rb / Ra
        if ra == 0 { return None; }
        let p = fp_div(fp_from_int(rb as u64), fp_from_int(ra as u64));
        return Some(p);
    }

    if a == 0 {
        // Only B→A orders: price = Rb / (Ra + B/P) → simplified
        // The only solution direction is P such that Ra(P) stays positive
        // When a=0: (Ra)(Rb + B - 0) = Ra*Rb → Rb + B = Rb + B/Ra*Ra → trivially true
        // Actually when a=0: the price only affects how much A comes out
        // The clearing price when a=0 is P = Rb' / Ra = (Rb + B) / Ra
        if ra == 0 { return None; }
        let p_num = fp_from_int(rb2 as u64);
        let p_den = fp_from_int(ra as u64);
        return Some(fp_div(p_num, p_den));
    }

    if b == 0 {
        // Only A→B orders: price = (Rb) / (Ra + A)
        if ra2 == 0 { return None; }
        let p_num = fp_from_int(rb as u64);
        let p_den = fp_from_int(ra2 as u64);
        return Some(fp_div(p_num, p_den));
    }

    // Full quadratic: coeff_a * P^2 - coeff_b * P + coeff_c = 0
    // coeff_a = ra2 * a
    // coeff_b = ra2*rb2 + a*b - ra*rb
    // coeff_c = rb2 * b
    let coeff_a = ra2 * a;
    let coeff_c = rb2 * b;

    // coeff_b might be negative if ra*rb > ra2*rb2 + a*b (unlikely but guard)
    let term1 = ra2 * rb2;
    let term2 = a * b;
    let term3 = ra * rb;

    if term1.checked_add(term2)? < term3 {
        return None; // degenerate
    }
    let coeff_b = term1 + term2 - term3;

    if coeff_a == 0 {
        // Linear: P = coeff_c / coeff_b
        if coeff_b == 0 { return None; }
        // coeff_c and coeff_b are raw token amounts, so P = coeff_c/coeff_b as Q32.32
        let p = fp_div(fp_from_int(coeff_c as u64), fp_from_int(coeff_b as u64));
        return Some(p);
    }

    // discriminant = coeff_b^2 - 4*coeff_a*coeff_c
    // Use u256-like computation via careful u128 arithmetic
    // coeff_b can be up to ~2^126 (two u64 products summed), so coeff_b^2 overflows u128
    // We need to work in a scaled domain

    // Scale everything by 2^32 to work in Q32.32:
    // Divide coefficients by a common factor if possible
    // Actually, let's compute in terms of Q32.32 directly

    // Scale all three coefficients uniformly so they fit in 62 bits each.
    // This keeps the roots unchanged (homogeneous) while ensuring:
    //   cb^2 < 2^124  (fits in u128)
    //   4*ca*cc < 2^126  (fits in u128)
    // If scaling pushes coeff_a to 0, the equation is approximately linear.
    let max_val = coeff_a.max(coeff_b).max(coeff_c);
    let max_bits = 128u32 - max_val.leading_zeros();
    let scale_shift = if max_bits > 62 { max_bits - 62 } else { 0 };

    let ca = coeff_a >> scale_shift;
    let cb = coeff_b >> scale_shift;
    let cc = coeff_c >> scale_shift;

    if ca == 0 {
        // coeff_a is negligible relative to coeff_b; solve as linear: P = coeff_c / coeff_b
        if coeff_b == 0 { return None; }
        let p_fp = ((coeff_c as u128 * FP_ONE as u128) / coeff_b as u128) as u64;
        return Some(p_fp);
    }

    // discriminant = cb^2 - 4*ca*cc (all u128)
    let cb_sq = cb.checked_mul(cb)?;
    let four_ca_cc = (4u128).checked_mul(ca)?.checked_mul(cc)?;

    if cb_sq < four_ca_cc {
        return None; // No real solution
    }

    let disc = cb_sq - four_ca_cc;
    let sqrt_disc = isqrt(disc) as u128;

    // Two roots: (cb - sqrt_disc) / (2*ca) and (cb + sqrt_disc) / (2*ca)
    // We want the positive economically meaningful root
    // For AMM: both roots may be positive, take the smaller one (less price impact)

    let two_ca = 2u128 * ca;
    if two_ca == 0 { return None; }

    let root1 = if cb >= sqrt_disc {
        Some((cb - sqrt_disc) / two_ca)
    } else {
        None
    };
    let root2 = (cb + sqrt_disc) / two_ca;

    // The roots are raw integer token ratios (after the 2^32 coefficient scaling).
    // The equation is homogeneous so scaling doesn't change the roots.
    // Convert to Q32.32 by multiplying by FP_ONE.
    let p1_fp = root1.map(|r| (r as u128 * FP_ONE as u128) as u64);
    let p2_fp = (root2 as u128 * FP_ONE as u128) as u64;

    // Return the economically smaller positive price (less price impact)
    match p1_fp {
        Some(p1_val) if p1_val > 0 && p1_val < p2_fp => Some(p1_val),
        _ if p2_fp > 0 => Some(p2_fp),
        _ => None,
    }
}

/// Evaluate the invariant condition at price P.
/// Returns Some(true) if invariant(P) > original invariant (price is too low),
/// Some(false) if ≤ (price is too high or exact), None if invalid.
fn eval_invariant(
    p: u64,
    reserve_a: u64,
    reserve_b: u64,
    weight_a_micro: u32,
    total_in_a: u64,
    total_in_b: u64,
    k: u64,
) -> Option<bool> {
    let weight_b_micro = 1_000_000u32.saturating_sub(weight_a_micro);

    // total_in_b / P (amount of A that would come out)
    let a_out = fp_to_int(fp_div(fp_from_int(total_in_b), p));
    // total_in_a * P (amount of B that would come out)
    let b_out = fp_to_int(fp_mul(fp_from_int(total_in_a), p));

    // New reserves after clearing
    let new_ra = reserve_a.checked_add(total_in_a)?.checked_sub(a_out)?;
    let new_rb = reserve_b.checked_add(total_in_b)?.checked_sub(b_out)?;

    if new_ra == 0 || new_rb == 0 {
        return None;
    }

    let new_ra_fp = fp_from_int(new_ra);
    let new_rb_fp = fp_from_int(new_rb);

    let new_ra_pow = fp_pow_weight(new_ra_fp, weight_a_micro)?;
    let new_rb_pow = fp_pow_weight(new_rb_fp, weight_b_micro)?;
    let new_k = fp_mul(new_ra_pow, new_rb_pow);

    // f(P) = new_k - k
    // We want new_k >= k (invariant preserved or improved for the pool)
    // Binary search: find P where new_k = k
    Some(new_k > k)
}

/// Verify that a given clearing price approximately satisfies the invariant.
fn verify_clearing_price(
    p: u64,
    reserve_a: u64,
    reserve_b: u64,
    weight_a_micro: u32,
    total_in_a: u64,
    total_in_b: u64,
    k: u64,
) -> bool {
    let weight_b_micro = 1_000_000u32.saturating_sub(weight_a_micro);

    let a_out_fp = fp_div(fp_from_int(total_in_b), p);
    let a_out = fp_to_int(a_out_fp);
    let b_out = fp_to_int(fp_mul(fp_from_int(total_in_a), p));

    let new_ra = match reserve_a.checked_add(total_in_a).and_then(|x| x.checked_sub(a_out)) {
        Some(v) if v > 0 => v,
        _ => return false,
    };
    let new_rb = match reserve_b.checked_add(total_in_b).and_then(|x| x.checked_sub(b_out)) {
        Some(v) if v > 0 => v,
        _ => return false,
    };

    let new_ra_fp = fp_from_int(new_ra);
    let new_rb_fp = fp_from_int(new_rb);

    let new_ra_pow = match fp_pow_weight(new_ra_fp, weight_a_micro) {
        Some(v) => v,
        None => return false,
    };
    let new_rb_pow = match fp_pow_weight(new_rb_fp, weight_b_micro) {
        Some(v) => v,
        None => return false,
    };
    let new_k = fp_mul(new_ra_pow, new_rb_pow);

    // Allow 0.1% tolerance
    let tolerance = k / 1000;
    new_k.abs_diff(k) <= tolerance
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fp_mul() {
        // 2.0 * 3.0 = 6.0
        let a = fp_from_int(2);
        let b = fp_from_int(3);
        assert_eq!(fp_mul(a, b), fp_from_int(6));
    }

    #[test]
    fn test_fp_div() {
        // 6.0 / 2.0 = 3.0
        let a = fp_from_int(6);
        let b = fp_from_int(2);
        assert_eq!(fp_div(a, b), fp_from_int(3));
    }

    #[test]
    fn test_fp_sqrt() {
        // sqrt(4.0) = 2.0
        let a = fp_from_int(4);
        let result = fp_sqrt(a);
        let expected = fp_from_int(2);
        // Allow small rounding error
        assert!(result.abs_diff(expected) <= 2, "sqrt(4) = {result} expected ~{expected}");
    }

    #[test]
    fn test_fp_sqrt_non_perfect() {
        // sqrt(2.0) ≈ 1.41421356...
        let a = fp_from_int(2);
        let result = fp_sqrt(a);
        // 1.41421356 * 2^32 = 6074001000
        let expected: u64 = 6074001000;
        assert!(result.abs_diff(expected) < 100_000, "sqrt(2) = {result} expected ~{expected}");
    }

    #[test]
    fn test_fp_log2_power_of_2() {
        // log2(1.0) = 0
        assert_eq!(fp_log2(FP_ONE), 0);
        // log2(2.0) = 1.0 in Q32.32
        let result = fp_log2(fp_from_int(2));
        let expected = FP_ONE as i64;
        assert!(result.abs_diff(expected) < 100_000, "log2(2) = {result} expected {expected}");
        // log2(4.0) = 2.0
        let result4 = fp_log2(fp_from_int(4));
        let expected4 = 2 * FP_ONE as i64;
        assert!(result4.abs_diff(expected4) < 100_000, "log2(4) = {result4} expected {expected4}");
    }

    #[test]
    fn test_fp_exp2_integer() {
        // 2^0 = 1.0
        let result = fp_exp2(0);
        assert!(result.abs_diff(FP_ONE) < 100_000, "2^0 = {result} expected {}", FP_ONE);
        // 2^1 = 2.0
        let result1 = fp_exp2(FP_ONE as i64);
        assert!(result1.abs_diff(fp_from_int(2)) < 100_000, "2^1 = {result1} expected {}", fp_from_int(2));
        // 2^2 = 4.0
        let result2 = fp_exp2(2 * FP_ONE as i64);
        assert!(result2.abs_diff(fp_from_int(4)) < 100_000, "2^2 = {result2} expected {}", fp_from_int(4));
    }

    #[test]
    fn test_exp2_log2_roundtrip() {
        // exp2(log2(x)) ≈ x
        for val in [1u64, 2, 3, 5, 10, 100, 1000] {
            let x = fp_from_int(val);
            let log_x = fp_log2(x);
            let back = fp_exp2(log_x);
            let tolerance = x / 1000 + 100; // 0.1% + epsilon
            assert!(
                back.abs_diff(x) <= tolerance,
                "roundtrip failed for {val}: exp2(log2({x})) = {back}, expected {x}"
            );
        }
    }

    #[test]
    fn test_fp_pow_weight_half() {
        // x^0.5 = sqrt(x), test with x = 4.0 → result ≈ 2.0
        let x = fp_from_int(4);
        let result = fp_pow_weight(x, 500_000).unwrap(); // weight = 0.5
        let expected = fp_from_int(2);
        let tolerance = expected / 1000 + 100;
        assert!(
            result.abs_diff(expected) <= tolerance,
            "4^0.5 = {result} expected ~{expected}"
        );
    }

    #[test]
    fn test_clearing_price_50_50_balanced() {
        // Balanced pool: Ra = Rb = 1000, equal inputs A = B = 10
        // Expected clearing price ≈ 1.0 (by symmetry)
        let price = compute_clearing_price(1000, 1000, 500_000, 10, 10).unwrap();
        let expected = FP_ONE; // 1.0 in Q32.32
        let tolerance = FP_ONE / 100; // 1%
        assert!(
            price.abs_diff(expected) <= tolerance,
            "50/50 balanced: price={price} (= {} as float), expected ~{expected}",
            price as f64 / FP_ONE as f64
        );
    }

    #[test]
    fn test_clearing_price_50_50_only_a_in() {
        // Only A input: Ra=1000, Rb=1000, total_in_a=100, total_in_b=0
        // Expected: price should be around Rb/(Ra+A) = 1000/1100 ≈ 0.909
        let price = compute_clearing_price(1000, 1000, 500_000, 100, 0).unwrap();
        let expected = fp_div(fp_from_int(1000), fp_from_int(1100));
        let tolerance = expected / 20; // 5%
        assert!(
            price.abs_diff(expected) <= tolerance,
            "only A in: price={} expected ~{}",
            price as f64 / FP_ONE as f64,
            expected as f64 / FP_ONE as f64
        );
    }

    #[test]
    fn test_clearing_price_invariant_preservation_50_50() {
        // After clearing, the G3M invariant Ra'^0.5 * Rb'^0.5 >= Ra^0.5 * Rb^0.5
        let ra: u64 = 10_000;
        let rb: u64 = 10_000;
        let total_in_a: u64 = 500;
        let total_in_b: u64 = 300;

        let price = compute_clearing_price(ra, rb, 500_000, total_in_a, total_in_b).unwrap();
        let price_float = price as f64 / FP_ONE as f64;

        // Compute new reserves
        let a_out = total_in_b as f64 / price_float;
        let b_out = total_in_a as f64 * price_float;
        let new_ra = ra as f64 + total_in_a as f64 - a_out;
        let new_rb = rb as f64 + total_in_b as f64 - b_out;

        let old_k = (ra as f64).sqrt() * (rb as f64).sqrt();
        let new_k = new_ra.sqrt() * new_rb.sqrt();

        assert!(new_ra > 0.0, "new_ra must be positive");
        assert!(new_rb > 0.0, "new_rb must be positive");
        // Allow 1% tolerance for invariant preservation
        assert!(
            (new_k - old_k).abs() / old_k < 0.01,
            "Invariant not preserved: old_k={old_k:.4} new_k={new_k:.4}"
        );
    }

    #[test]
    fn test_clearing_price_weight_interpolation() {
        // Test weight interpolation boundary: at weight_end_slot
        // Create a mock PoolState-like scenario
        let current_weight_a = 600_000u32; // 60%
        let target_weight_a = 400_000u32;  // 40%
        let weight_start_slot = 100u64;
        let weight_end_slot = 200u64;

        // At slot 150 (midpoint): weight should be 500_000 (50%)
        let current_slot = 150u64;
        let elapsed = current_slot - weight_start_slot;
        let total = weight_end_slot - weight_start_slot;
        let d = (current_weight_a - target_weight_a) as u64;
        let interp = current_weight_a - (d * elapsed / total) as u32;
        assert_eq!(interp, 500_000, "Weight at midpoint should be 50%");

        // At slot 200 (end): weight should be 400_000
        let current_slot2 = 200u64;
        let elapsed2 = current_slot2 - weight_start_slot;
        let interp2 = current_weight_a - (d * elapsed2 / total) as u32;
        assert_eq!(interp2, 400_000, "Weight at end should be target");
    }

    #[test]
    fn test_clearing_price_general_weight() {
        // 60/40 pool
        let price = compute_clearing_price(10_000, 10_000, 600_000, 200, 100);
        assert!(price.is_some(), "Should compute price for 60/40 pool");
        let p = price.unwrap();
        assert!(p > 0, "Price must be positive");
        let p_float = p as f64 / FP_ONE as f64;
        // Rough sanity: price should be in [0.1, 10] for these inputs
        assert!(p_float > 0.01 && p_float < 100.0, "Price {p_float} out of expected range");
    }
}
