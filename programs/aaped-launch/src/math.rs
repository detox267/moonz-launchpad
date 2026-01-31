use anchor_lang::prelude::*;
use crate::errors::AapedError;

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000;

pub const V_SOL: u128 = 30 * LAMPORTS_PER_SOL;
pub const V_TOK: u128 = 526_200_000 * TOKEN_DECIMALS;

pub const MIGRATION_SOL_TARGET: u128 = 85 * LAMPORTS_PER_SOL;
pub const LP_TOTAL: u128 = 400_000_000 * TOKEN_DECIMALS;

#[inline]
pub fn bps_amount(amount: u128, bps: u128) -> Result<u128> {
    let mul = amount.checked_mul(bps).ok_or(error!(AapedError::MathOverflow))?;
    let div = mul.checked_div(10_000).ok_or(error!(AapedError::MathOverflow))?;
    Ok(div)
}

/// Split fees: base + LP growth
pub fn split_trade_fee(sol_in: u128, base_bps: u128, lp_bps: u128) -> Result<(u128, u128)> {
    let base = bps_amount(sol_in, base_bps)?;
    let lp = bps_amount(sol_in, lp_bps)?;
    Ok((base, lp))
}

/// Constant product curve buy
pub fn curve_buy(sol_in: u128, sol_real: u128, tok_real: u128, fee_bps: u128)
-> Result<(u128, u128, u128)>
{
    let fee_total = bps_amount(sol_in, fee_bps)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    let r_sol = V_SOL.checked_add(sol_real).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(error!(AapedError::MathOverflow))?;

    let k = r_sol.checked_mul(r_tok).ok_or(error!(AapedError::MathOverflow))?;

    let r_sol_new = r_sol.checked_add(sol_eff).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok_new = k.checked_div(r_sol_new).ok_or(error!(AapedError::MathOverflow))?;

    let tokens_out = r_tok.checked_sub(r_tok_new).ok_or(error!(AapedError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}

/// Optional sell math
pub fn curve_sell(tokens_in: u128, sol_real: u128, tok_real: u128, fee_bps: u128)
-> Result<(u128, u128, u128)>
{
    let r_sol = V_SOL.checked_add(sol_real).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(error!(AapedError::MathOverflow))?;

    let k = r_sol.checked_mul(r_tok).ok_or(error!(AapedError::MathOverflow))?;

    let r_tok_new = r_tok.checked_add(tokens_in).ok_or(error!(AapedError::MathOverflow))?;
    let r_sol_new = k.checked_div(r_tok_new).ok_or(error!(AapedError::MathOverflow))?;

    let sol_gross = r_sol.checked_sub(r_sol_new).ok_or(error!(AapedError::MathOverflow))?;

    let fee_total = bps_amount(sol_gross, fee_bps)?;
    let sol_net = sol_gross.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    Ok((sol_gross, fee_total, sol_net))
}

/// Tail pricing
pub fn tail_buy(sol_in: u128, fee_bps: u128)
-> Result<(u128, u128, u128)>
{
    let fee_total = bps_amount(sol_in, fee_bps)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(error!(AapedError::MathOverflow))?;

    let tokens_out = sol_eff
        .checked_mul(LP_TOTAL)
        .ok_or(error!(AapedError::MathOverflow))?
        .checked_div(MIGRATION_SOL_TARGET)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}

