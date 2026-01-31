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
    #[msg("Fee config invalid")]
    FeeConfigInvalid,
    #[msg("Invalid Vault")]
    InvalidVault,

}
