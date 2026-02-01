use anchor_lang::prelude::*;

#[repr(u8)]
pub enum LaunchPhase {
    Curve = 0,
    Tail = 1,
    MigrationPending = 2,
    Migrated = 3,
}

#[account]
pub struct LaunchState {
    pub bump: u8,
    pub state: u8,

    pub mint: Pubkey,
    pub creator: Pubkey,
    pub platform: Pubkey,

    // token vaults
    pub sale_vault: Pubkey,
    pub lp_vault: Pubkey,

    // SOL vaults (system accounts owned by PDA)
    pub treasury_sol_vault: Pubkey,
    pub creator_sol_vault: Pubkey,
    pub platform_sol_vault: Pubkey,

    // tokenomics
    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    // curve config
    pub v_sol: u64,
    pub v_tok: u64,

    // tail thresholds
    pub tail_start: u64,
    pub tail_end: u64,

    // migration target
    pub migration_sol_target: u64,

    // fees
    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,
    pub fee_lp_growth_bps: u16,

    // accounting
    pub tokens_sold: u64,
    pub sol_collected: u128,
    pub lp_growth_sol: u128,

    // ✅ NEW: tail terminal price (tokens per lamport) captured at Curve→Tail boundary
    pub tail_price_tokens_per_lamport: u128,

    // timing
    pub launch_ts: i64,
    pub last_trade_ts: i64,
}

impl LaunchState {
    pub const LEN: usize =
        8  // discriminator
        + 1  // bump
        + 1  // state
        + 32 // mint
        + 32 // creator
        + 32 // platform
        + 32 // sale_vault
        + 32 // lp_vault
        + 32 // treasury
        + 32 // creator sol
        + 32 // platform sol
        + 8  // total_supply
        + 8  // sale_supply
        + 8  // lp_supply
        + 8  // v_sol
        + 8  // v_tok
        + 8  // tail_start
        + 8  // tail_end
        + 8  // migration target
        + 2  // fee_total
        + 2  // fee_creator
        + 2  // fee_platform
        + 2  // fee_lp_growth
        + 8  // tokens_sold
        + 16 // sol_collected
        + 16 // lp_growth_sol
        + 16 // ✅ tail_price_tokens_per_lamport
        + 8  // launch_ts
        + 8; // last_trade_ts
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub creator: Pubkey,
    pub platform: Pubkey,

    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    pub v_sol: u64,
    pub v_tok: u64,

    pub tail_start: u64,
    pub tail_end: u64,

    pub migration_sol_target: u64,

    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,
    pub fee_lp_growth_bps: u16,
}
