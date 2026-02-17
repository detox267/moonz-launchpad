use anchor_lang::prelude::*;

#[error_code]
pub enum AapedError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Launch already migrated")]
    AlreadyMigrated,
    #[msg("Zero output")]
    ZeroOutput,
    #[msg("Insufficient sale liquidity")]
    InsufficientSaleLiquidity,
    #[msg("Insufficient treasury liquidity")]
    InsufficientTreasuryLiquidity,
    #[msg("Fee config invalid")]
    FeeConfigInvalid,
    #[msg("Invalid Vault")]
    InvalidVault,
    #[msg("Invalid launch state for this instruction")]
    InvalidState,
    #[msg("Unauthorized")]
    Unauthorized,
}
