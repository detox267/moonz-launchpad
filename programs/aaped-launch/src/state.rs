use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum SaleState {
    Curve,
    Tail,
    MigrationPending,
    Migrated,
}

#[account]
pub struct LaunchState {
    pub state: SaleState,
    pub sold_tokens: u64,
    pub sol_collected: u64,
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub lp_vault: Pubkey,
    pub tail_vault: Pubkey,
    pub sale_vault: Pubkey,
    pub mint: Pubkey,
    pub state_bump: u8,
    pub lp_bump: u8,
    pub tail_bump: u8,
    pub _padding: [u8; 64],
}

impl LaunchState {
    pub const LEN: usize =
        8 + 
        1 + 
        8 + 8 +
        32 + 32 +
        32 + 32 + 32 +
        32 +
        1 + 1 + 1 +
        64;
}
