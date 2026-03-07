use anchor_lang::prelude::*;

/// Launch phases stored on-chain as a u8 in `LaunchState.state`
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchPhase {
    PendingDevBuy = 0,
    Curve = 1,
    MigrationPending = 2,
    AmmLive = 3,
    Migrated = 4,
}

#[account]
pub struct LaunchState {
    // --- bumps ---
    pub bump: u8,
    pub treasury_sol_bump: u8,
    pub creator_sol_bump: u8,
    pub escrow_sol_bump: u8,

    // --- state ---
    pub state: u8,

    // --- identities ---
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub core_authority: Pubkey,

    // --- vaults ---
    pub sale_vault: Pubkey,
    pub lp_vault: Pubkey,
    pub treasury_sol_vault: Pubkey,
    pub creator_sol_vault: Pubkey,
    pub escrow_sol_vault: Pubkey,

    // --- supply ---
    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    // --- curve ---
    pub v_sol: u64,
    pub v_tok: u64,

    // --- migration ---
    pub migration_sol_target: u64,
    pub amm_initial_sol: u64,
    pub amm_initial_tok: u64,
    pub migrated_at: i64,

    // --- fees ---
    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,

    // --- accounting ---
    pub tokens_sold: u64,
    pub sol_collected: u128,

    // --- timing ---
    pub launch_ts: i64,
    pub last_trade_ts: i64,

    // --- metaplex ---
    pub metadata: Pubkey,

    // --- lifecycle flags ---
    pub dev_buy_done: bool,
    pub escrow_settled: bool,
}

impl LaunchState {
    pub const LEN: usize =
        8 +   // discriminator
        1 +   // bump
        1 +   // treasury_sol_bump
        1 +   // creator_sol_bump
        1 +   // escrow_sol_bump
        1 +   // state
        32 +  // mint
        32 +  // creator
        32 +  // platform
        32 +  // core_authority
        32 +  // sale_vault
        32 +  // lp_vault
        32 +  // treasury_sol_vault
        32 +  // creator_sol_vault
        32 +  // escrow_sol_vault
        8 +   // total_supply
        8 +   // sale_supply
        8 +   // lp_supply
        8 +   // v_sol
        8 +   // v_tok
        8 +   // migration_sol_target
        8 +   // amm_initial_sol
        8 +   // amm_initial_tok
        8 +   // migrated_at
        2 +   // fee_total_bps
        2 +   // fee_creator_bps
        2 +   // fee_platform_bps
        8 +   // tokens_sold
        16 +  // sol_collected
        8 +   // launch_ts
        8 +   // last_trade_ts
        32 +  // metadata
        1 +   // dev_buy_done
        1;    // escrow_settled
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub core_authority: Pubkey,

    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    pub v_sol: u64,
    pub v_tok: u64,

    pub migration_sol_target: u64,

    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,

    // metadata
    pub name: String,
    pub symbol: String,
    pub uri: String,
    }
