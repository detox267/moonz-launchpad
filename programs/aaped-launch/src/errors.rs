use anchor_lang::prelude::*;

#[error_code]
pub enum MoonzError {
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Math overflow")]
    MathOverflow,

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

    #[msg("Invalid fee receiver")]
    InvalidFeeReceiver,

    #[msg("Slippage exceeded")]
    SlippageExceeded,

    #[msg("Platform wallet mismatch")]
    PlatformMismatch,

    #[msg("Pool switch cooldown active")]
    SwitchCooldownActive,

    #[msg("Escrow already funded")]
    EscrowAlreadyFunded,

    #[msg("Escrow not funded")]
    EscrowNotFunded,

    #[msg("Escrow already executed")]
    EscrowAlreadyExecuted,

    #[msg("Escrow refund is not available")]
    EscrowRefundUnavailable,

    #[msg("Escrow timeout has not been reached")]
    EscrowTimeoutNotReached,

    #[msg("Invalid escrow creator")]
    InvalidEscrowCreator,
}
