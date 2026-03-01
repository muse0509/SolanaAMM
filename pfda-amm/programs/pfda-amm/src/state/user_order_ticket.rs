/// UserOrderTicket - 112 bytes, repr(C)
///
/// PDA seeds: [b"ticket", pool_key, owner_key, batch_id.to_le_bytes()]
#[repr(C)]
#[derive(Clone, Copy)]
pub struct UserOrderTicket {
    /// Discriminator: b"usrorder"
    pub discriminator: [u8; 8],
    /// Owner (user) public key
    pub owner: [u8; 32],
    /// Pool state address
    pub pool: [u8; 32],
    /// Batch ID this order belongs to
    pub batch_id: u64,
    /// Amount of token A the user deposited (0 if B→A swap)
    pub amount_in_a: u64,
    /// Amount of token B the user deposited (0 if A→B swap)
    pub amount_in_b: u64,
    /// Minimum acceptable output amount (slippage protection)
    pub min_amount_out: u64,
    /// Whether this ticket has been claimed
    pub is_claimed: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Alignment padding
    pub _padding: [u8; 6],
}

impl UserOrderTicket {
    pub const DISCRIMINATOR: [u8; 8] = *b"usrorder";
    pub const LEN: usize = core::mem::size_of::<UserOrderTicket>();

    pub fn is_initialized(&self) -> bool {
        self.discriminator == Self::DISCRIMINATOR
    }
}

// Compile-time size assertion
const _: () = assert!(core::mem::size_of::<UserOrderTicket>() == 112);
