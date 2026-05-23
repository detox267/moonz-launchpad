use anchor_lang::prelude::*;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchPhase {
    PendingDevBuy = 0,
    Curve = 1,
    MigrationPending = 2,
    AmmLive = 3,
    Migrated = 4,
    Switching = 5,
}

#[account]
pub struct LaunchState {
    // --- bumps ---
    pub bump: u8,
    pub treasury_wsol_bump: u8,
    pub treasury_usdc_bump: u8,
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
    pub treasury_wsol_vault: Pubkey,
    pub treasury_usdc_vault: Pubkey,
    pub escrow_sol_vault: Pubkey,

    // --- supply ---
    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    // --- migration snapshot / AMM start snapshot ---
    pub amm_initial_sol: u64,
    pub amm_initial_tok: u64,
    pub migrated_at: i64,

    // --- AMM config ---
    pub amm_type: u8,
    pub lp_share_claim_base: u64,

    // --- quote asset switching ---
    pub quote_asset: u8,
    pub pending_quote_asset: u8,
    pub last_pool_switch_ts: i64,
    pub switch_started_at: i64,

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
    pub metadata_initialized: bool,
    pub mint_finalized: bool,
}

impl LaunchState {
    pub const LEN: usize =
        8 +   // discriminator
        1 +   // bump
        1 +   // treasury_wsol_bump
        1 +   // treasury_usdc_bump
        1 +   // escrow_sol_bump
        1 +   // state
        32 +  // mint
        32 +  // creator
        32 +  // platform
        32 +  // core_authority
        32 +  // sale_vault
        32 +  // lp_vault
        32 +  // treasury_wsol_vault
        32 +  // treasury_usdc_vault
        32 +  // escrow_sol_vault
        8 +   // total_supply
        8 +   // sale_supply
        8 +   // lp_supply
        8 +   // amm_initial_sol
        8 +   // amm_initial_tok
        8 +   // migrated_at
        1 +   // amm_type
        8 +   // lp_share_claim_base
        1 +   // quote_asset
        1 +   // pending_quote_asset
        8 +   // last_pool_switch_ts
        8 +   // switch_started_at
        2 +   // fee_total_bps
        2 +   // fee_creator_bps
        2 +   // fee_platform_bps
        8 +   // tokens_sold
        16 +  // sol_collected
        8 +   // launch_ts
        8 +   // last_trade_ts
        32 +  // metadata
        1 +   // dev_buy_done
        1 +   // escrow_settled
        1 +   // metadata_initialized
        1;    // mint_finalized
}

#[account]
pub struct LaunchEscrow {
    pub bump: u8,
    pub escrow_sol_bump: u8,

    pub creator: Pubkey,
    pub mint: Pubkey,

    pub create_fee_lamports: u64,
    pub dev_buy_lamports: u64,
    pub deposited_lamports: u64,

    pub created_at: i64,

    pub executed: bool,
    pub refunded: bool,
}

impl LaunchEscrow {
    pub const LEN: usize =
        8 +   // discriminator
        1 +   // bump
        1 +   // escrow_sol_bump
        32 +  // creator
        32 +  // mint
        8 +   // create_fee_lamports
        8 +   // dev_buy_lamports
        8 +   // deposited_lamports
        8 +   // created_at
        1 +   // executed
        1;    // refunded
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub core_authority: Pubkey,

    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,

    pub fee_total_bps: u16,
    pub fee_creator_bps: u16,
    pub fee_platform_bps: u16,

    pub amm_type: u8,

    // metadata
    pub name: String,
    pub symbol: String,
    pub uri: String,
}
