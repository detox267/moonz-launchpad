use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Wrong state for this action")]
    WrongState,

    #[msg("Slippage exceeded")]
    Slippage,

    #[msg("Insufficient SOL liquidity in vault")]
    InsufficientLiquidity,

    #[msg("Sale sold out")]
    Soldout,

    #[msg("Math overflow")]
    MathOverflow,
}