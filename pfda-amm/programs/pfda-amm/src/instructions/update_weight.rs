use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{self, Pubkey},
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    error::PfmmError,
    state::{load_mut, PoolState},
};

/// Accounts for UpdateWeight:
/// 0. `[signer]`    authority
/// 1. `[writable]`  pool_state PDA
pub fn process_update_weight(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    target_weight_a: u32,
    weight_end_slot: u64,
) -> ProgramResult {
    if target_weight_a > 1_000_000 {
        return Err(PfmmError::InvalidWeight.into());
    }

    let [authority, pool_state_ai, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let current_slot = Clock::get()?.slot;
    if weight_end_slot <= current_slot {
        return Err(PfmmError::InvalidWindowSlots.into());
    }

    let mut data = pool_state_ai.try_borrow_mut_data()?;
    let pool = unsafe { load_mut::<PoolState>(&mut data) }
        .ok_or(ProgramError::InvalidAccountData)?;

    if !pool.is_initialized() {
        return Err(PfmmError::InvalidDiscriminator.into());
    }

    // Verify PDA
    let (expected, _) = pubkey::find_program_address(
        &[b"pool", &pool.token_a_mint, &pool.token_b_mint],
        program_id,
    );
    if pool_state_ai.key() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }

    // Snapshot the current interpolated weight as the new start point so
    // the transition begins smoothly from wherever the weight currently is.
    let current_interpolated = pool.interpolated_weight_a(current_slot);

    pool.current_weight_a = current_interpolated;
    pool.target_weight_a  = target_weight_a;
    pool.weight_start_slot = current_slot;
    pool.weight_end_slot   = weight_end_slot;

    Ok(())
}
