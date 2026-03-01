use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{self, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;

use crate::{
    error::PfmmError,
    state::{load_mut, BatchQueue, PoolState},
};

/// Accounts for InitializePool:
/// 0. `[signer, writable]` payer
/// 1. `[writable]`          pool_state PDA
/// 2. `[writable]`          batch_queue PDA (batch_id=0)
/// 3. `[]`                  token_a_mint
/// 4. `[]`                  token_b_mint
/// 5. `[writable]`          vault_a  (SPL token account, uninitialized)
/// 6. `[writable]`          vault_b  (SPL token account, uninitialized)
/// 7. `[]`                  system_program
/// 8. `[]`                  token_program
pub fn process_initialize_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    base_fee_bps: u16,
    fee_discount_bps: u16,
    window_slots: u64,
    initial_weight_a: u32,
) -> ProgramResult {
    if window_slots == 0 {
        return Err(PfmmError::InvalidWindowSlots.into());
    }
    if initial_weight_a > 1_000_000 {
        return Err(PfmmError::InvalidWeight.into());
    }

    let [payer, pool_state_ai, batch_queue_ai, token_a_mint, token_b_mint, vault_a, vault_b, system_program, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let token_a_key = token_a_mint.key();
    let token_b_key = token_b_mint.key();

    // Derive and verify pool_state PDA
    let (expected_pool_key, pool_bump) =
        pubkey::find_program_address(&[b"pool", token_a_key, token_b_key], program_id);
    if pool_state_ai.key() != &expected_pool_key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check not already initialized
    {
        let data = pool_state_ai.try_borrow_data()?;
        if data.len() >= 8 && data[..8] == PoolState::DISCRIMINATOR {
            return Err(PfmmError::AlreadyInitialized.into());
        }
    }

    let clock = Clock::get()?;
    let rent = Rent::get()?;

    // Create pool_state account
    let pool_lamports = rent.minimum_balance(PoolState::LEN);
    let pool_bump_seed = [pool_bump];
    let pool_signer_seeds = [
        Seed::from(b"pool".as_ref()),
        Seed::from(token_a_key.as_ref()),
        Seed::from(token_b_key.as_ref()),
        Seed::from(pool_bump_seed.as_ref()),
    ];

    CreateAccount {
        from: payer,
        to: pool_state_ai,
        lamports: pool_lamports,
        space: PoolState::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&pool_signer_seeds)])?;

    // Initialize vault_a token account (pool_state PDA as authority)
    InitializeAccount3 {
        account: vault_a,
        mint: token_a_mint,
        owner: &expected_pool_key,
    }
    .invoke()?;

    // Initialize vault_b token account
    InitializeAccount3 {
        account: vault_b,
        mint: token_b_mint,
        owner: &expected_pool_key,
    }
    .invoke()?;

    // Initialize pool_state
    {
        let mut data = pool_state_ai.try_borrow_mut_data()?;
        let pool = unsafe { load_mut::<PoolState>(&mut data) }
            .ok_or(ProgramError::InvalidAccountData)?;

        *pool = PoolState {
            discriminator: PoolState::DISCRIMINATOR,
            token_a_mint: *token_a_key,
            token_b_mint: *token_b_key,
            vault_a: *vault_a.key(),
            vault_b: *vault_b.key(),
            reserve_a: 0,
            reserve_b: 0,
            current_weight_a: initial_weight_a,
            target_weight_a: initial_weight_a,
            weight_start_slot: clock.slot,
            weight_end_slot: clock.slot,
            window_slots,
            current_batch_id: 0,
            current_window_end: clock.slot + window_slots,
            base_fee_bps,
            fee_discount_bps,
            bump: pool_bump,
            reentrancy_guard: 0,
            _padding: [0; 2],
        };
    }

    // Derive and verify batch_queue PDA for batch_id = 0
    let batch_id_bytes = 0u64.to_le_bytes();
    let (expected_queue_key, queue_bump) = pubkey::find_program_address(
        &[b"queue", pool_state_ai.key(), &batch_id_bytes],
        program_id,
    );
    if batch_queue_ai.key() != &expected_queue_key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create batch_queue account
    let queue_lamports = rent.minimum_balance(BatchQueue::LEN);
    let queue_bump_seed = [queue_bump];
    let queue_signer_seeds = [
        Seed::from(b"queue".as_ref()),
        Seed::from(pool_state_ai.key().as_ref()),
        Seed::from(batch_id_bytes.as_ref()),
        Seed::from(queue_bump_seed.as_ref()),
    ];

    CreateAccount {
        from: payer,
        to: batch_queue_ai,
        lamports: queue_lamports,
        space: BatchQueue::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&queue_signer_seeds)])?;

    // Initialize batch_queue
    {
        let mut data = batch_queue_ai.try_borrow_mut_data()?;
        let queue = unsafe { load_mut::<BatchQueue>(&mut data) }
            .ok_or(ProgramError::InvalidAccountData)?;

        *queue = BatchQueue {
            discriminator: BatchQueue::DISCRIMINATOR,
            pool: *pool_state_ai.key(),
            batch_id: 0,
            total_in_a: 0,
            total_in_b: 0,
            window_end_slot: clock.slot + window_slots,
            bump: queue_bump,
            _padding: [0; 7],
        };
    }

    Ok(())
}
