use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{self, Pubkey},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    error::PfmmError,
    state::{load, load_mut, PoolState},
};

/// Accounts for AddLiquidity:
/// 0. `[signer, writable]` user
/// 1. `[writable]`          pool_state PDA
/// 2. `[writable]`          vault_a
/// 3. `[writable]`          vault_b
/// 4. `[writable]`          user_token_a
/// 5. `[writable]`          user_token_b
/// 6. `[]`                  token_program
pub fn process_add_liquidity(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_a: u64,
    amount_b: u64,
) -> ProgramResult {
    if amount_a == 0 && amount_b == 0 {
        return Err(PfmmError::InvalidSwapInput.into());
    }

    let [user, pool_state_ai, vault_a, vault_b, user_token_a, user_token_b, _token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify pool_state PDA and initialization
    {
        let data = pool_state_ai.try_borrow_data()?;
        let pool = unsafe { load::<PoolState>(&data) }.ok_or(ProgramError::InvalidAccountData)?;
        if !pool.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        let (expected, _) = pubkey::find_program_address(
            &[b"pool", &pool.token_a_mint, &pool.token_b_mint],
            program_id,
        );
        if pool_state_ai.key() != &expected {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    // Transfer token A from user to vault_a
    if amount_a > 0 {
        Transfer {
            from: user_token_a,
            to: vault_a,
            authority: user,
            amount: amount_a,
        }
        .invoke()?;
    }

    // Transfer token B from user to vault_b
    if amount_b > 0 {
        Transfer {
            from: user_token_b,
            to: vault_b,
            authority: user,
            amount: amount_b,
        }
        .invoke()?;
    }

    // Update reserves
    {
        let mut data = pool_state_ai.try_borrow_mut_data()?;
        let pool = unsafe { load_mut::<PoolState>(&mut data) }
            .ok_or(ProgramError::InvalidAccountData)?;

        pool.reserve_a = pool
            .reserve_a
            .checked_add(amount_a)
            .ok_or(PfmmError::Overflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_add(amount_b)
            .ok_or(PfmmError::Overflow)?;
    }

    Ok(())
}
