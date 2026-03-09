use anchor_lang::prelude::*;
use crate::errors::AapedError;

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000; // 6 decimals

pub const V_SOL: u128 = 64 * LAMPORTS_PER_SOL + 500_000_000; // 34.5 SOL
pub const V_TOK: u128 = 520_000_000 * TOKEN_DECIMALS;

#[inline]
pub fn bps_amount(amount: u128, bps: u128) -> Result<u128> {
    let mul = amount
        .checked_mul(bps)
        .ok_or(error!(AapedError::MathOverflow))?;
    Ok(mul
        .checked_div(10_000)
        .ok_or(error!(AapedError::MathOverflow))?)
}

#[inline]
pub fn ceil_div(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, AapedError::MathOverflow);

    let b_minus_1 = b
        .checked_sub(1)
        .ok_or(error!(AapedError::MathOverflow))?;

    let num = a
        .checked_add(b_minus_1)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok(num
        .checked_div(b)
        .ok_or(error!(AapedError::MathOverflow))?)
}

/// Convert NET sol_eff back to GROSS sol_in such that:
/// net = gross - fee(gross)
/// gross = ceil(net * 10000 / (10000 - fee_bps))
pub fn gross_from_net(net: u128, fee_bps: u128) -> Result<u128> {
    if fee_bps == 0 {
        return Ok(net);
    }

    let denom = 10_000u128
        .checked_sub(fee_bps)
        .ok_or(error!(AapedError::MathOverflow))?;
    require!(denom > 0, AapedError::MathOverflow);

    let num = net
        .checked_mul(10_000)
        .ok_or(error!(AapedError::MathOverflow))?;

    ceil_div(num, denom)
}

pub fn curve_buy(
    sol_in: u128,
    sol_real: u128,
    tok_real: u128,
    fee_bps: u128,
) -> Result<(u128, u128, u128)> {
    let fee_total = bps_amount(sol_in, fee_bps)?;
    let sol_eff = sol_in
        .checked_sub(fee_total)
        .ok_or(error!(AapedError::MathOverflow))?;

    let r_sol = V_SOL
        .checked_add(sol_real)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(AapedError::MathOverflow))?;

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(AapedError::MathOverflow))?;

    let r_sol_new = r_sol
        .checked_add(sol_eff)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_tok_new = k
        .checked_div(r_sol_new)
        .ok_or(error!(AapedError::MathOverflow))?;

    let tokens_out = r_tok
        .checked_sub(r_tok_new)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}

pub fn curve_sell_gross(tokens_in: u128, sol_real: u128, tok_real: u128) -> Result<u128> {
    let r_sol = V_SOL
        .checked_add(sol_real)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(AapedError::MathOverflow))?;

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(AapedError::MathOverflow))?;

    let r_tok_new = r_tok
        .checked_add(tokens_in)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_sol_new = k
        .checked_div(r_tok_new)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok(r_sol
        .checked_sub(r_sol_new)
        .ok_or(error!(AapedError::MathOverflow))?)
}

pub fn curve_sol_eff_for_exact_tokens_cp(
    target_tokens: u128,
    sol_collected: u128,
    tok_real: u128,
) -> Result<u128> {
    require!(target_tokens > 0, AapedError::ZeroOutput);

    let r_sol = V_SOL
        .checked_add(sol_collected)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(AapedError::MathOverflow))?;

    require!(target_tokens < r_tok, AapedError::InsufficientSaleLiquidity);

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(AapedError::MathOverflow))?;
    let r_tok_new = r_tok
        .checked_sub(target_tokens)
        .ok_or(error!(AapedError::MathOverflow))?;

    let r_sol_new = k
        .checked_div(r_tok_new)
        .ok_or(error!(AapedError::MathOverflow))?;

    let sol_eff_needed = r_sol_new
        .checked_sub(r_sol)
        .ok_or(error!(AapedError::MathOverflow))?;

    require!(sol_eff_needed > 0, AapedError::InvalidAmount);
    Ok(sol_eff_needed)
}

/// Buy quote for curve only.
/// Fees are externalized in lib.rs.
pub fn quote_buy(
    sol_in: u128,
    sol_real: u128,
    tok_real: u128,
    fee_total_bps: u128,
) -> Result<(u128, u128)> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    let base_fee = bps_amount(sol_in, fee_total_bps)?;
    let sol_eff = sol_in
        .checked_sub(base_fee)
        .ok_or(error!(AapedError::MathOverflow))?;

    let (tokens_out, _, _) = curve_buy(sol_eff, sol_real, tok_real, 0)?;
    require!(tokens_out > 0, AapedError::ZeroOutput);

    Ok((tokens_out, base_fee))
}

/// Sell quote for curve only.
/// Fees are externalized in lib.rs.
pub fn quote_sell(
    tokens_in: u128,
    sol_real: u128,
    tok_real: u128,
    fee_total_bps: u128,
) -> Result<(u128, u128)> {
    require!(tokens_in > 0, AapedError::InvalidAmount);

    let sol_gross = curve_sell_gross(tokens_in, sol_real, tok_real)?;
    require!(sol_gross > 0, AapedError::ZeroOutput);

    let base_fee = bps_amount(sol_gross, fee_total_bps)?;

    let sol_out_net = sol_gross
        .checked_sub(base_fee)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok((sol_out_net, base_fee))
}

/// AMM sell gross SOL output before fee split.
pub fn amm_sell_sol_out_gross(tokens_in: u128, x_sol: u128, y_tok: u128) -> Result<u128> {
    let k = x_sol
        .checked_mul(y_tok)
        .ok_or(error!(AapedError::MathOverflow))?;
    let y_new = y_tok
        .checked_add(tokens_in)
        .ok_or(error!(AapedError::MathOverflow))?;
    let x_new = k
        .checked_div(y_new)
        .ok_or(error!(AapedError::MathOverflow))?;
    let sol_out = x_sol
        .checked_sub(x_new)
        .ok_or(error!(AapedError::MathOverflow))?;
    Ok(sol_out)
}

/// AMM fee split:
/// total fee = 1%
/// - lp       0.6%
/// - creator  0.3%
/// - platform 0.1%
pub fn amm_quote_buy(sol_in: u128) -> Result<(u128, u128, u128, u128)> {
    // returns: (sol_trade, lp_fee, creator_fee, platform_fee)
    let fee_total = bps_amount(sol_in, 100)?; // 1%

    let lp_fee = fee_total
        .checked_mul(60)
        .ok_or(error!(AapedError::MathOverflow))?
        .checked_div(100)
        .ok_or(error!(AapedError::MathOverflow))?;

    let creator_fee = fee_total
        .checked_mul(30)
        .ok_or(error!(AapedError::MathOverflow))?
        .checked_div(100)
        .ok_or(error!(AapedError::MathOverflow))?;

    let platform_fee = fee_total
        .checked_sub(lp_fee)
        .ok_or(error!(AapedError::MathOverflow))?
        .checked_sub(creator_fee)
        .ok_or(error!(AapedError::MathOverflow))?;

    let sol_trade = sol_in
        .checked_sub(fee_total)
        .ok_or(error!(AapedError::MathOverflow))?;

    Ok((sol_trade, lp_fee, creator_fee, platform_fee))
}

pub fn amm_buy_tokens_out(sol_trade: u128, x_sol: u128, y_tok: u128) -> Result<u128> {
    let k = x_sol
        .checked_mul(y_tok)
        .ok_or(error!(AapedError::MathOverflow))?;
    let x_new = x_sol
        .checked_add(sol_trade)
        .ok_or(error!(AapedError::MathOverflow))?;
    let y_new = k
        .checked_div(x_new)
        .ok_or(error!(AapedError::MathOverflow))?;
    let out = y_tok
        .checked_sub(y_new)
        .ok_or(error!(AapedError::MathOverflow))?;
    Ok(out)
}
