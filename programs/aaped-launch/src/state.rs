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

    // PDA bumps
    pub treasury_sol_bump: u8,
    pub creator_sol_bump: u8,
    pub platform_sol_bump: u8,

    pub state: u8,

    pub mint: Pubkey,
    pub creator: Pubkey,
    pub platform: Pubkey,

    // token vaults
    pub sale_vault: Pubkey,
    pub lp_vault: Pubkey,

    // SOL vaults
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

    // accounting (LAMPORTS)
    pub tokens_sold: u64,
    pub sol_collected: u64,     // ✅ u64
    pub lp_growth_sol: u64,     // ✅ u64

    // tail pricing
    pub tail_price_tokens_per_lamport: u128,

    // timing
    pub launch_ts: i64,
    pub last_trade_ts: i64,
}

impl LaunchState {
    pub const LEN: usize =
        8 + // discriminator
        1 + // bump
        1 + 1 + 1 + // vault bumps
        1 + // state
        32 * 7 + // pubkeys
        8 * 6 + // supplies + curve + tail + migration
        2 * 4 + // fees
        8 * 3 + // accounting
        16 +    // tail price
        8 + 8;  // timestamps
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