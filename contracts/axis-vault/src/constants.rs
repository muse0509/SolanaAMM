//! Shared constants for axis-vault.

/// SPL Token Program ID, byte-encoded so we can compare owners without a
/// string conversion. Kept here so Deposit and Withdraw reference one source.
pub const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
    0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
    0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

/// Maximum allowed divergence (in basis points) between the highest and
/// lowest per-vault mint candidates computed during Deposit. Larger gaps
/// imply the vault is out of ratio with the basket's target weights — the
/// deposit could over- or under-mint relative to any single token. We
/// reject early with `NavDeviationExceeded` rather than minting at a stale
/// composition. 300 bps = 3 %.
pub const MAX_NAV_DEVIATION_BPS: u64 = 300;

/// Minimum base amount accepted on the first deposit into a fresh ETF.
/// Closes the cheap-attacker leg of the inflation / donation attack:
/// without this, an attacker could seed with `amount = 1`, then donate
/// huge quantities of basket tokens directly into the vault ATAs to
/// push every proportional-mint candidate to zero for the next legitimate
/// depositor (they would revert on `ZeroDeposit`, bricking the pool).
///
/// Keep this above `MINIMUM_LIQUIDITY`, but do not force a full 1.0 ETF at
/// genesis. A 1_000_000 floor made high-value, low-raw-unit basket legs
/// (wBTC/wETH) require too much SOL just to bootstrap. 10_000 = 0.01 ETF
/// at 6 decimals, which preserves the virtual-liquidity defense while
/// making mixed-decimal/high-price baskets deployable.
pub const MIN_FIRST_DEPOSIT: u64 = 10_000;

/// Virtual liquidity lock added to `etf.total_supply` on the first
/// deposit but never minted to any holder. Combined with
/// `MIN_FIRST_DEPOSIT` this keeps `vault_balance / total_supply`
/// bounded below for the life of the ETF so that vault donations can
/// never round proportional math to zero. Mirrors Uniswap V2's
/// `MINIMUM_LIQUIDITY = 1_000`. Because nobody holds these tokens,
/// they can never be withdrawn — a tiny amount of each basket token
/// is permanently stranded in the vaults, which is the intended cost.
pub const MINIMUM_LIQUIDITY: u64 = 1_000;

/// Program-wide hard ceiling for `fee_bps`. SetFee rejects above this
/// regardless of per-ETF `max_fee_bps`. Belt-and-suspenders against a
/// compromised authority dialling fees up to 100 % to drain a pool;
/// 300 bps (3 %) is well above any realistic AMM fee while leaving
/// no room for fee-as-attack. Per-ETF `max_fee_bps` set at CreateEtf
/// time may be lower (e.g. 100 bps for stable-stable baskets) but
/// can never exceed this.
pub const MAX_FEE_BPS_CEILING: u16 = 300;

/// Default fee captured at CreateEtf for the v3 EtfState. Authority
/// can adjust via SetFee within `[0, max_fee_bps]`.
pub const DEFAULT_FEE_BPS: u16 = 30;

/// Default per-ETF `max_fee_bps` written by CreateEtf. Authority can
/// not raise this — it's the per-ETF ceiling. CreateEtf accepts
/// callers wanting to lock in a tighter ceiling via instruction data
/// (future enhancement); for now we set the program-wide ceiling and
/// let SetFee operate freely below it.
pub const DEFAULT_MAX_FEE_BPS: u16 = MAX_FEE_BPS_CEILING;

/// Protocol treasury multisig address — the single destination for
/// protocol fee revenue.
///
/// Per @muse0509 on #38 (2026-04-20), the closed-beta treasury is a
/// protocol-wide Squads V4 multisig co-managed by @muse0509 and
/// @kidneyweakx. `CreateEtf` enforces a governance gate that rejects any
/// `treasury` pubkey not equal to this constant **once the constant is
/// non-zero** — while it stays `[0u8; 32]` the gate is inert so tests and
/// ad-hoc devnet flows can still create ETFs against throwaway
/// treasuries. Flipping this value to the deployed Squads vault key is a
/// one-line change and takes the gate live with no further code edits.
///
/// TODO(ops #38): replace zeros with the deployed Squads V4 vault key
/// once provisioned on devnet → mainnet.
#[cfg(not(feature = "e2e-disable-treasury-gate"))]
pub const PROTOCOL_TREASURY: [u8; 32] = [
    0xa1, 0xd5, 0xff, 0x64, 0xa6, 0x8a, 0x6f, 0x41,
    0xb9, 0xce, 0x8c, 0x9b, 0x4c, 0x4e, 0x50, 0x49,
    0x42, 0x69, 0xaa, 0xd0, 0x81, 0x7a, 0x10, 0xf3,
    0x6c, 0x2b, 0x96, 0x4c, 0x37, 0xd9, 0xd6, 0xef,
];

/// Local-validator E2E override: keeps the gate inert so tests can
/// CreateEtf with a throwaway treasury keypair (needed because
/// `SweepTreasury` requires the stored treasury to sign, and we
/// can't sign for the Squads multisig in CI). The verifiable
/// Docker build never enables this feature.
#[cfg(feature = "e2e-disable-treasury-gate")]
pub const PROTOCOL_TREASURY: [u8; 32] = [0u8; 32];

/// Returns true when `PROTOCOL_TREASURY` has been set to a real address
/// (i.e. the Squads V4 multisig is deployed and the constant above has
/// been flipped). Used by `CreateEtf` to conditionally enforce the
/// governance gate on `etf.treasury`.
pub const fn protocol_treasury_is_active() -> bool {
    let mut i = 0;
    while i < 32 {
        if PROTOCOL_TREASURY[i] != 0 {
            return true;
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_active_after_squads_treasury_flip() {
        assert!(protocol_treasury_is_active());
        assert_eq!(
            PROTOCOL_TREASURY,
            [
                0xa1, 0xd5, 0xff, 0x64, 0xa6, 0x8a, 0x6f, 0x41,
                0xb9, 0xce, 0x8c, 0x9b, 0x4c, 0x4e, 0x50, 0x49,
                0x42, 0x69, 0xaa, 0xd0, 0x81, 0x7a, 0x10, 0xf3,
                0x6c, 0x2b, 0x96, 0x4c, 0x37, 0xd9, 0xd6, 0xef,
            ],
        );
    }

    #[test]
    fn gate_active_when_any_byte_nonzero() {
        let mut k = [0u8; 32];
        k[17] = 1;
        let active = k.iter().any(|b| *b != 0);
        assert!(active);
    }
}
