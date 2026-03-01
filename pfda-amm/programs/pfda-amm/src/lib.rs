//! PFDA AMM — Price-Function Deterministic Auction AMM
//!
//! A Solana on-chain AMM using batch auctions with G3M (Generalized Geometric Mean Market Maker)
//! clearing prices and TFMM (Time-Weighted Function Market Maker) weight transitions.

#![cfg_attr(not(test), no_std)]

pub mod error;
pub mod instructions;
pub mod math;
pub mod state;

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::entrypoint!(process_instruction);

/// Instruction discriminators (first 1 byte of instruction data)
#[repr(u8)]
enum Instruction {
    InitializePool = 0,
    SwapRequest = 1,
    ClearBatch = 2,
    Claim = 3,
}

impl Instruction {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Instruction::InitializePool),
            1 => Some(Instruction::SwapRequest),
            2 => Some(Instruction::ClearBatch),
            3 => Some(Instruction::Claim),
            _ => None,
        }
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let discriminant = Instruction::from_u8(instruction_data[0])
        .ok_or(ProgramError::InvalidInstructionData)?;
    let data = &instruction_data[1..];

    match discriminant {
        Instruction::InitializePool => {
            // Layout: [base_fee_bps: u16 LE][fee_discount_bps: u16 LE][window_slots: u64 LE][initial_weight_a: u32 LE]
            if data.len() < 16 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let base_fee_bps = u16::from_le_bytes([data[0], data[1]]);
            let fee_discount_bps = u16::from_le_bytes([data[2], data[3]]);
            let window_slots = u64::from_le_bytes([
                data[4], data[5], data[6], data[7], data[8], data[9], data[10], data[11],
            ]);
            let initial_weight_a = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);

            instructions::process_initialize_pool(
                program_id,
                accounts,
                base_fee_bps,
                fee_discount_bps,
                window_slots,
                initial_weight_a,
            )
        }

        Instruction::SwapRequest => {
            // Layout: [amount_in_a: u64 LE][amount_in_b: u64 LE][min_amount_out: u64 LE]
            if data.len() < 24 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let amount_in_a = u64::from_le_bytes([
                data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
            ]);
            let amount_in_b = u64::from_le_bytes([
                data[8], data[9], data[10], data[11], data[12], data[13], data[14], data[15],
            ]);
            let min_amount_out = u64::from_le_bytes([
                data[16], data[17], data[18], data[19], data[20], data[21], data[22], data[23],
            ]);

            instructions::process_swap_request(
                program_id,
                accounts,
                amount_in_a,
                amount_in_b,
                min_amount_out,
            )
        }

        Instruction::ClearBatch => {
            // No additional data needed
            instructions::process_clear_batch(program_id, accounts)
        }

        Instruction::Claim => {
            // No additional data needed (all context from accounts)
            instructions::process_claim(program_id, accounts)
        }
    }
}
