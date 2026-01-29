use anchor_lang::prelude::*;

pub enum Error Code{
    #[msg("Wrong state for this action")]
    WrongState,
    #[msg("Slippage Exceeded")]
    Slippage,
    #[msg("Insufficient SOL. liquidity in vault")]
    InsufficientLiquidity,
    #[msg("Sale Sold out")]
    Soldout,
    #[msg("Math overflow")]
    MathOverflow,
}