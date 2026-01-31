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

    // vaults
    pub sale_vault: Pubkey,
    pub lp_vault: Pubkey,

    // SOL vaults (system accounts owned by program PDA)
    pub treasury_sol_vault: Pubkey,
    pub creator_sol_vault: Pubkey,
    pub platform_sol_vault: Pubkey,

    // tokenomics (all in smallest units, decimals already applied)
    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    // curve config (fixed-point basis, keep as u64 for now; math uses u128)
    pub v_sol: u64, // lamports virtual
    pub v_tok: u64, // token units virtual

    // tail thresholds (token units remaining in sale vault)
    pub tail_start: u64,
    pub tail_end: u64,

    // migration conditions
    pub migration_sol_target: u64, // lamports target

    // fees in basis points
    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,
    pub fee_lp_growth_bps: u16,

    // accounting
    pub tokens_sold: u64,
    pub sol_collected: u128, // store in u128 to avoid overflow
}

impl LaunchState {
    pub const LEN: usize =
        8  // disc
        + 1  // bump
        + 1  // state
        + 32 // mint
        + 32 // creator
        + 32 // platform
        + 32 // sale_vault
        + 32 // lp_vault
        + 32 // treasury_sol_vault
        + 32 // creator_sol_vault
        + 32 // platform_sol_vault
        + 8  // total_supply
        + 8  // sale_supply
        + 8  // lp_supply
        + 8  // v_sol
        + 8  // v_tok
        + 8  // tail_start
        + 8  // tail_end
        + 8  // migration_sol_target
        + 2  // fee_total_bps
        + 2  // fee_creator_bps
        + 2  // fee_platform_bps
        + 2  // fee_lp_growth_bps
        + 8  // tokens_sold
        + 16; // sol_collected
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub creator: Pubkey,
    pub platform: Pubkey,

    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    // curve config
    pub v_sol: u64,
    pub v_tok: u64,

    // tail thresholds
    pub tail_start: u64,
    pub tail_end: u64,

    pub migration_sol_target: u64,

    // fees
    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,
    pub fee_lp_growth_bps: u16,
}
