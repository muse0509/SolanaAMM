/// BatchQueue - 80 bytes, repr(C)
///
/// PDA seeds: [b"queue", pool_key, batch_id.to_le_bytes()]
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BatchQueue {
    /// Discriminator: b"batchque"
    pub discriminator: [u8; 8],
    /// Pool state address
    pub pool: [u8; 32],
    /// Batch ID
    pub batch_id: u64,
    /// Total token A input accumulated in this batch
    pub total_in_a: u64,
    /// Total token B input accumulated in this batch
    pub total_in_b: u64,
    /// Slot at which this batch window ends
    pub window_end_slot: u64,
    /// PDA bump seed
    pub bump: u8,
    /// Alignment padding
    pub _padding: [u8; 7],
}

impl BatchQueue {
    pub const DISCRIMINATOR: [u8; 8] = *b"batchque";
    pub const LEN: usize = core::mem::size_of::<BatchQueue>();

    pub fn is_initialized(&self) -> bool {
        self.discriminator == Self::DISCRIMINATOR
    }
}

// Compile-time size assertion
const _: () = assert!(core::mem::size_of::<BatchQueue>() == 80);
