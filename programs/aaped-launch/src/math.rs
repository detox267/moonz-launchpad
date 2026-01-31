use anchor_lang::prelude::*;
use crate::errors::AapedError;

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000;

pub const V_SOL: u128 = 30 * LAMPORTS_PER_SOL;
pub const V_TOK: u128 = 526_200_000 * TOKEN_DECIMALS;

pub const SALE_TOTAL: u128 = 600_000_000 * TOKEN_DECIMALS;
pub const TAIL_START_REMAIN: u128 = 15_000_000 * TOKEN_DECIMALS;
pub const TAIL_END_REMAIN: u128 = 5_000_000 * TOKEN_DECIMALS;

pub const MIGRATION_SOL_TARGET: u128 = 85 * LAMPORTS_PER_SOL;
pub const LP_TOTAL: u128 = 400_000_000u128 * TOKEN_DECIMALS;

// Fees (bps)
pub const FEE_TOTAL_BPS: u128 = 125;
pub const FEE_CREATOR_BPS: u128 = 80;
pub const FEE_PLATFORM_BPS: u128 = 20;
pub const FEE_LP_GROWTH_BPS: u128 = 25;

#[inline]
pub fn bps_amount(amount: u128, bps: u128) -> Result<u128> {
    let mul = amount.checked_mul(bps).ok_or(error!(AapedError::MathOverflow))?;
    let div = mul.checked_div(10_000).ok_or(error!(AapedError::MathOverflow))?;
    Ok(div)
}

/// Buy on curve
pub fn curve_buy(sol_in: u128, sol_real: u128, tok_real: u128) -> Result<(u128, u128, u128)> {
    let fee_total = bps_amount(sol_in, FEE_TOTAL_BPS)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    let r_sol = V_SOL.checked_add(sol_real).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(error!(AapedError::MathOverflow))?;

    let k = r_sol.checked_mul(r_tok).ok_or(error!(AapedError::MathOverflow))?;

    let r_sol_new = r_sol.checked_add(sol_eff).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok_new = k.checked_div(r_sol_new).ok_or(error!(AapedError::MathOverflow))?;

    let tokens_out = r_tok.checked_sub(r_tok_new).ok_or(error!(AapedError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}

/// Sell on curve
pub fn curve_sell(tokens_in: u128, sol_real: u128, tok_real: u128) -> Result<(u128, u128, u128)> {
    let r_sol = V_SOL.checked_add(sol_real).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(error!(AapedError::MathOverflow))?;
    let k = r_sol.checked_mul(r_tok).ok_or(error!(AapedError::MathOverflow))?;

    let r_tok_new = r_tok.checked_add(tokens_in).ok_or(error!(AapedError::MathOverflow))?;
    let r_sol_new = k.checked_div(r_tok_new).ok_or(error!(AapedError::MathOverflow))?;

    let sol_gross = r_sol.checked_sub(r_sol_new).ok_or(error!(AapedError::MathOverflow))?;
    let fee_total = bps_amount(sol_gross, FEE_TOTAL_BPS)?;
    let sol_net = sol_gross.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    Ok((sol_gross, fee_total, sol_net))
}

pub fn tail_buy(sol_in: u128) -> Result<(u128, u128, u128)> {
    let fee_total = bps_amount(sol_in, FEE_TOTAL_BPS)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    let tokens_out = sol_eff
        .checked_mul(LP_TOTAL)
        .ok_or(error!(AapedError::MathOverflow))?
        .checked_div(MIGRATION_SOL_TARGET)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}
