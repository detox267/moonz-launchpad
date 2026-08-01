use anchor_lang::prelude::*;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchPhase {
    PendingDevBuy = 0,
    Curve = 1,
    AmmLive = 2,
    Switching = 3,
    Cancelled = 4,
}

#[account]
pub struct LaunchState {
    // --- PDA bumps ---
    pub bump: u8,
    pub escrow_sol_bump: u8,

    // --- lifecycle ---
    pub state: u8,
    pub dev_buy_done: bool,
    pub escrow_settled: bool,
    pub metadata_initialized: bool,
    pub mint_finalized: bool,

    // --- identities ---
    pub mint: Pubkey,
    pub creator: Pubkey,

    // Creator-approved commitment to mint/name/symbol/URI.
    pub metadata_commitment: [u8; 32],

    // --- vaults ---
    pub sale_vault: Pubkey,
    pub lp_vault: Pubkey,
    pub treasury_wsol_vault: Pubkey,
    pub treasury_usdc_vault: Pubkey,
    pub escrow_sol_vault: Pubkey,

    // --- bonding accounting ---
    pub sale_supply: u64,
    pub tokens_sold: u64,
    pub sol_collected: u128,

    // --- AMM quote switching ---
    pub quote_asset: u8,
    pub pending_quote_asset: u8,
    pub last_pool_switch_ts: i64,
    pub switch_started_at: i64,
    pub switch_fee_escrowed_lamports: u64,
    pub switch_amount_in: u64,
    pub switch_min_amount_out: u64,
    pub switch_swap_executed: bool,

    // --- timing ---
    pub last_trade_ts: i64,

    // --- Metaplex metadata PDA ---
    pub metadata: Pubkey,
}

impl LaunchState {
    pub const LEN: usize = 8 +   // discriminator
        1 +   // bump
        1 +   // escrow_sol_bump
        1 +   // state
        1 +   // dev_buy_done
        1 +   // escrow_settled
        1 +   // metadata_initialized
        1 +   // mint_finalized
        32 +  // mint
        32 +  // creator
        32 +  // metadata_commitment
        32 +  // sale_vault
        32 +  // lp_vault
        32 +  // treasury_wsol_vault
        32 +  // treasury_usdc_vault
        32 +  // escrow_sol_vault
        8 +   // sale_supply
        8 +   // tokens_sold
        16 +  // sol_collected
        1 +   // quote_asset
        1 +   // pending_quote_asset
        8 +   // last_pool_switch_ts
        8 +   // switch_started_at
        8 +   // switch_fee_escrowed_lamports
        8 +   // switch_amount_in
        8 +   // switch_min_amount_out
        1 +   // switch_swap_executed
        8 +   // last_trade_ts
        32; // metadata
}

#[account]
pub struct LaunchEscrow {
    pub bump: u8,
    pub escrow_sol_bump: u8,

    pub creator: Pubkey,
    pub mint: Pubkey,

    pub create_fee_lamports: u64,
    pub dev_buy_lamports: u64,
    pub dev_buy_min_tokens_out: u64,
    pub deposited_lamports: u64,

    // Creator-approved commitment to mint/name/symbol/URI.
    pub metadata_commitment: [u8; 32],

    pub created_at: i64,

    pub initialized: bool,
    pub executed: bool,
    pub refunded: bool,
}

impl LaunchEscrow {
    pub const LEN: usize = 8 +   // discriminator
        1 +   // bump
        1 +   // escrow_sol_bump
        32 +  // creator
        32 +  // mint
        8 +   // create_fee_lamports
        8 +   // dev_buy_lamports
        8 +   // dev_buy_min_tokens_out
        8 +   // deposited_lamports
        32 +  // metadata_commitment
        8 +   // created_at
        1 +   // initialized
        1 +   // executed
        1; // refunded
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub creator: Pubkey,

    // metadata
    pub name: String,
    pub symbol: String,
    pub uri: String,
}
