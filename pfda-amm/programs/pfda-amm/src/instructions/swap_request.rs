use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{self, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::{
    error::PfmmError,
    state::{load, load_mut, BatchQueue, PoolState, UserOrderTicket},
};

/// Accounts for SwapRequest:
/// 0. `[signer, writable]` user
/// 1. `[]`                  pool_state PDA
/// 2. `[writable]`          batch_queue PDA (current batch)
/// 3. `[writable]`          user_order_ticket PDA (new)
/// 4. `[writable]`          user_token_account_a (source if A→B swap)
/// 5. `[writable]`          user_token_account_b (source if B→A swap)
/// 6. `[writable]`          vault_a
/// 7. `[writable]`          vault_b
/// 8. `[]`                  token_program
/// 9. `[]`                  system_program
pub fn process_swap_request(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount_in_a: u64,
    amount_in_b: u64,
    min_amount_out: u64,
) -> ProgramResult {
    // Exactly one of amount_in_a/amount_in_b must be > 0
    if (amount_in_a == 0) == (amount_in_b == 0) {
        return Err(PfmmError::InvalidSwapInput.into());
    }

    let [user, pool_state_ai, batch_queue_ai, ticket_ai, user_token_a, user_token_b, vault_a, vault_b, token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Load and validate pool_state
    let (pool_key, current_batch_id, current_window_end, window_slots) = {
        let data = pool_state_ai.try_borrow_data()?;
        let pool = unsafe { load::<PoolState>(&data) }.ok_or(ProgramError::InvalidAccountData)?;

        if !pool.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        if pool.reentrancy_guard != 0 {
            return Err(PfmmError::ReentrancyDetected.into());
        }

        // Verify this is a valid pool PDA
        let (expected_pool, _bump) = pubkey::find_program_address(
            &[b"pool", &pool.token_a_mint, &pool.token_b_mint],
            program_id,
        );
        if pool_state_ai.key() != &expected_pool {
            return Err(ProgramError::InvalidSeeds);
        }

        (
            *pool_state_ai.key(),
            pool.current_batch_id,
            pool.current_window_end,
            pool.window_slots,
        )
    };

    // Check we are within the current batch window
    let current_slot = Clock::get()?.slot;
    if current_slot > current_window_end {
        // Window has passed; caller should first call ClearBatch
        return Err(PfmmError::BatchWindowNotEnded.into());
    }

    // Validate batch_queue PDA
    let batch_id_bytes = current_batch_id.to_le_bytes();
    let (expected_queue, _queue_bump) = pubkey::find_program_address(
        &[b"queue", &pool_key, &batch_id_bytes],
        program_id,
    );
    if batch_queue_ai.key() != &expected_queue {
        return Err(ProgramError::InvalidSeeds);
    }

    // Transfer tokens into vault
    if amount_in_a > 0 {
        Transfer {
            from: user_token_a,
            to: vault_a,
            authority: user,
            amount: amount_in_a,
        }
        .invoke()?;
    } else {
        Transfer {
            from: user_token_b,
            to: vault_b,
            authority: user,
            amount: amount_in_b,
        }
        .invoke()?;
    }

    // Update batch_queue totals
    {
        let mut data = batch_queue_ai.try_borrow_mut_data()?;
        let queue =
            unsafe { load_mut::<BatchQueue>(&mut data) }.ok_or(ProgramError::InvalidAccountData)?;

        if !queue.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        if queue.batch_id != current_batch_id {
            return Err(PfmmError::BatchIdMismatch.into());
        }

        queue.total_in_a = queue
            .total_in_a
            .checked_add(amount_in_a)
            .ok_or(PfmmError::Overflow)?;
        queue.total_in_b = queue
            .total_in_b
            .checked_add(amount_in_b)
            .ok_or(PfmmError::Overflow)?;
    }

    // Create UserOrderTicket PDA
    let user_key = user.key();
    let (expected_ticket, ticket_bump) = pubkey::find_program_address(
        &[b"ticket", &pool_key, user_key, &batch_id_bytes],
        program_id,
    );
    if ticket_ai.key() != &expected_ticket {
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?;
    let ticket_lamports = rent.minimum_balance(UserOrderTicket::LEN);

    let ticket_bump_seed = [ticket_bump];
    let ticket_signer_seeds = [
        Seed::from(b"ticket".as_ref()),
        Seed::from(pool_key.as_ref()),
        Seed::from(user_key.as_ref()),
        Seed::from(batch_id_bytes.as_ref()),
        Seed::from(ticket_bump_seed.as_ref()),
    ];

    CreateAccount {
        from: user,
        to: ticket_ai,
        lamports: ticket_lamports,
        space: UserOrderTicket::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&ticket_signer_seeds)])?;

    // Initialize ticket
    {
        let mut data = ticket_ai.try_borrow_mut_data()?;
        let ticket = unsafe { load_mut::<UserOrderTicket>(&mut data) }
            .ok_or(ProgramError::InvalidAccountData)?;

        *ticket = UserOrderTicket {
            discriminator: UserOrderTicket::DISCRIMINATOR,
            owner: *user_key,
            pool: pool_key,
            batch_id: current_batch_id,
            amount_in_a,
            amount_in_b,
            min_amount_out,
            is_claimed: false,
            bump: ticket_bump,
            _padding: [0; 6],
        };
    }

    Ok(())
}
