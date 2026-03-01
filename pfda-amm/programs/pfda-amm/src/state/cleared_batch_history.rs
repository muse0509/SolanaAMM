/// ClearedBatchHistory - 80 bytes, repr(C)
///
/// PDA seeds: [b"history", pool_key, batch_id.to_le_bytes()]
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ClearedBatchHistory {
    /// Discriminator: b"clrdhist"
    pub discriminator: [u8; 8],
    /// Pool state address
    pub pool: [u8; 32],
    /// Batch ID
    pub batch_id: u64,
    /// Clearing price in Q32.32 (B per A)
    pub clearing_price: u64,
    /// Output rate for A→B swaps in Q32.32 (token B out per token A in, after fees)
    pub out_b_per_in_a: u64,
    /// Output rate for B→A swaps in Q32.32 (token A out per token B in, after fees)
    pub out_a_per_in_b: u64,
    /// Whether this batch has been cleared
    pub is_cleared: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Alignment padding
    pub _padding: [u8; 6],
}

impl ClearedBatchHistory {
    pub const DISCRIMINATOR: [u8; 8] = *b"clrdhist";
    pub const LEN: usize = core::mem::size_of::<ClearedBatchHistory>();

    pub fn is_initialized(&self) -> bool {
        self.discriminator == Self::DISCRIMINATOR
    }
}

// Compile-time size assertion
const _: () = assert!(core::mem::size_of::<ClearedBatchHistory>() == 80);
