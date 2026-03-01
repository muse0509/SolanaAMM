/// PoolState - 216 bytes, repr(C)
///
/// PDA seeds: [b"pool", token_a_mint, token_b_mint]
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PoolState {
    /// Discriminator: b"poolstat"
    pub discriminator: [u8; 8],
    /// Token A mint address
    pub token_a_mint: [u8; 32],
    /// Token B mint address
    pub token_b_mint: [u8; 32],
    /// Pool-controlled token A vault
    pub vault_a: [u8; 32],
    /// Pool-controlled token B vault
    pub vault_b: [u8; 32],
    /// Current reserve of token A
    pub reserve_a: u64,
    /// Current reserve of token B
    pub reserve_b: u64,
    /// Current weight of token A in micro-units (divide by 1_000_000 for fraction)
    pub current_weight_a: u32,
    /// Target weight of token A for TFMM weight transition
    pub target_weight_a: u32,
    /// Slot at which weight transition begins
    pub weight_start_slot: u64,
    /// Slot at which weight transition ends
    pub weight_end_slot: u64,
    /// Number of slots per batch window
    pub window_slots: u64,
    /// Current batch ID being accumulated
    pub current_batch_id: u64,
    /// Slot at which the current batch window ends
    pub current_window_end: u64,
    /// Base fee in basis points
    pub base_fee_bps: u16,
    /// Fee discount for searchers in basis points
    pub fee_discount_bps: u16,
    /// PDA bump seed
    pub bump: u8,
    /// Reentrancy guard: 0 = open, 1 = locked
    pub reentrancy_guard: u8,
    /// Alignment padding
    pub _padding: [u8; 2],
}

impl PoolState {
    pub const DISCRIMINATOR: [u8; 8] = *b"poolstat";
    pub const LEN: usize = core::mem::size_of::<PoolState>();

    pub fn is_initialized(&self) -> bool {
        self.discriminator == Self::DISCRIMINATOR
    }

    /// Interpolate current weight_a based on current slot.
    /// Returns weight_a in micro-units (0..=1_000_000).
    pub fn interpolated_weight_a(&self, current_slot: u64) -> u32 {
        if current_slot >= self.weight_end_slot {
            return self.target_weight_a;
        }
        if current_slot <= self.weight_start_slot {
            return self.current_weight_a;
        }
        let elapsed = current_slot - self.weight_start_slot;
        let total = self.weight_end_slot - self.weight_start_slot;
        let delta = if self.target_weight_a >= self.current_weight_a {
            let d = (self.target_weight_a - self.current_weight_a) as u64;
            (d * elapsed / total) as u32
        } else {
            let d = (self.current_weight_a - self.target_weight_a) as u64;
            let sub = (d * elapsed / total) as u32;
            // saturating sub handled below
            return self.current_weight_a.saturating_sub(sub);
        };
        self.current_weight_a + delta
    }
}

// Compile-time size assertion (actual layout = 208 bytes)
const _: () = assert!(core::mem::size_of::<PoolState>() == 208);
