use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{self, Pubkey},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    error::PfmmError,
    math::{fp_from_int, fp_mul, fp_to_int},
    state::{load, load_mut, ClearedBatchHistory, PoolState, UserOrderTicket},
};

/// Accounts for Claim:
/// 0. `[signer]`            user (owner of the ticket)
/// 1. `[]`                  pool_state PDA
/// 2. `[]`                  cleared_batch_history PDA
/// 3. `[writable]`          user_order_ticket PDA
/// 4. `[writable]`          vault_a (source for B→A swaps)
/// 5. `[writable]`          vault_b (source for A→B swaps)
/// 6. `[writable]`          user_token_account_a (dest for B→A swaps)
/// 7. `[writable]`          user_token_account_b (dest for A→B swaps)
/// 8. `[]`                  token_program
pub fn process_claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [user, pool_state_ai, history_ai, ticket_ai, vault_a, vault_b, user_token_a, user_token_b, _token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Load pool_state for PDA seeds
    let (pool_key, pool_bump, token_a_mint, token_b_mint) = {
        let data = pool_state_ai.try_borrow_data()?;
        let pool = unsafe { load::<PoolState>(&data) }.ok_or(ProgramError::InvalidAccountData)?;
        if !pool.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        let (expected, bump) = pubkey::find_program_address(
            &[b"pool", &pool.token_a_mint, &pool.token_b_mint],
            program_id,
        );
        if pool_state_ai.key() != &expected {
            return Err(ProgramError::InvalidSeeds);
        }
        (*pool_state_ai.key(), bump, pool.token_a_mint, pool.token_b_mint)
    };

    // Load cleared_batch_history
    let (batch_id, out_b_per_in_a, out_a_per_in_b) = {
        let data = history_ai.try_borrow_data()?;
        let history =
            unsafe { load::<ClearedBatchHistory>(&data) }.ok_or(ProgramError::InvalidAccountData)?;
        if !history.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        if !history.is_cleared {
            return Err(PfmmError::BatchNotCleared.into());
        }
        if &history.pool != pool_key.as_ref() {
            return Err(PfmmError::PoolMismatch.into());
        }

        // Verify history PDA
        let history_batch_bytes = history.batch_id.to_le_bytes();
        let (expected_history, _) = pubkey::find_program_address(
            &[b"history", &pool_key, &history_batch_bytes],
            program_id,
        );
        if history_ai.key() != &expected_history {
            return Err(ProgramError::InvalidSeeds);
        }

        (history.batch_id, history.out_b_per_in_a, history.out_a_per_in_b)
    };

    // Load and validate user_order_ticket
    let (amount_in_a, amount_in_b, min_amount_out, _ticket_bump) = {
        let data = ticket_ai.try_borrow_data()?;
        let ticket =
            unsafe { load::<UserOrderTicket>(&data) }.ok_or(ProgramError::InvalidAccountData)?;
        if !ticket.is_initialized() {
            return Err(PfmmError::InvalidDiscriminator.into());
        }
        if ticket.is_claimed {
            return Err(PfmmError::TicketAlreadyClaimed.into());
        }
        if ticket.batch_id != batch_id {
            return Err(PfmmError::BatchIdMismatch.into());
        }
        if &ticket.pool != pool_key.as_ref() {
            return Err(PfmmError::PoolMismatch.into());
        }
        if &ticket.owner != user.key().as_ref() {
            return Err(PfmmError::OwnerMismatch.into());
        }

        // Verify ticket PDA
        let batch_bytes = batch_id.to_le_bytes();
        let (expected_ticket, _) = pubkey::find_program_address(
            &[b"ticket", &pool_key, user.key(), &batch_bytes],
            program_id,
        );
        if ticket_ai.key() != &expected_ticket {
            return Err(ProgramError::InvalidSeeds);
        }

        (ticket.amount_in_a, ticket.amount_in_b, ticket.min_amount_out, ticket.bump)
    };

    // Compute output amount
    let (amount_out, is_a_to_b) = if amount_in_a > 0 {
        // A→B: out = amount_in_a * out_b_per_in_a (Q32.32)
        let out = fp_to_int(fp_mul(fp_from_int(amount_in_a), out_b_per_in_a));
        (out, true)
    } else {
        // B→A: out = amount_in_b * out_a_per_in_b (Q32.32)
        let out = fp_to_int(fp_mul(fp_from_int(amount_in_b), out_a_per_in_b));
        (out, false)
    };

    // Pool PDA signer seeds for vault CPI transfers
    let pool_bump_seed = [pool_bump];
    let pool_signer_seeds = [
        Seed::from(b"pool".as_ref()),
        Seed::from(token_a_mint.as_ref()),
        Seed::from(token_b_mint.as_ref()),
        Seed::from(pool_bump_seed.as_ref()),
    ];

    // Slippage protection
    if amount_out < min_amount_out {
        // Return input tokens to the user
        if amount_in_a > 0 {
            Transfer {
                from: vault_a,
                to: user_token_a,
                authority: pool_state_ai,
                amount: amount_in_a,
            }
            .invoke_signed(&[Signer::from(&pool_signer_seeds)])?;
        } else {
            Transfer {
                from: vault_b,
                to: user_token_b,
                authority: pool_state_ai,
                amount: amount_in_b,
            }
            .invoke_signed(&[Signer::from(&pool_signer_seeds)])?;
        }

        // Mark ticket as claimed to prevent double-claiming
        {
            let mut data = ticket_ai.try_borrow_mut_data()?;
            let ticket = unsafe { load_mut::<UserOrderTicket>(&mut data) }
                .ok_or(ProgramError::InvalidAccountData)?;
            ticket.is_claimed = true;
        }

        return Err(PfmmError::SlippageExceeded.into());
    }

    // Transfer output tokens from vault to user
    if is_a_to_b {
        Transfer {
            from: vault_b,
            to: user_token_b,
            authority: pool_state_ai,
            amount: amount_out,
        }
        .invoke_signed(&[Signer::from(&pool_signer_seeds)])?;
    } else {
        Transfer {
            from: vault_a,
            to: user_token_a,
            authority: pool_state_ai,
            amount: amount_out,
        }
        .invoke_signed(&[Signer::from(&pool_signer_seeds)])?;
    }

    // Mark ticket as claimed
    {
        let mut data = ticket_ai.try_borrow_mut_data()?;
        let ticket = unsafe { load_mut::<UserOrderTicket>(&mut data) }
            .ok_or(ProgramError::InvalidAccountData)?;
        ticket.is_claimed = true;
    }

    Ok(())
}
