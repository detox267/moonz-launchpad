use anchor_lang::prelude::*;
use crate::errors::AapedError;

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000;

pub const V_SOL: u128 = 75 * LAMPORTS_PER_SOL + 800_000_000; // 75.8 SOL
pub const V_TOK: u128 = 526_200_000 * TOKEN_DECIMALS;

#[inline]
pub fn bps_amount(amount: u128, bps: u128) -> Result<u128> {
    let mul = amount.checked_mul(bps).ok_or(error!(AapedError::MathOverflow))?;
    let div = mul.checked_div(10_000).ok_or(error!(AapedError::MathOverflow))?;
    Ok(div)
}

#[inline]
pub fn ceil_div(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, AapedError::MathOverflow);
    Ok(a
        .checked_add(b.checked_sub(1).ok_or(AapedError::MathOverflow)?)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(b)
        .ok_or(AapedError::MathOverflow)?)
}

/// Given NET (after base fee), compute minimal GROSS such that gross - fee(gross) >= net.
/// This is how we “refund” without refund CPI: we only transfer the gross_used, not the max.
pub fn gross_from_net(net: u128, fee_bps: u128) -> Result<u128> {
    if fee_bps == 0 {
        return Ok(net);
    }
    let denom = 10_000u128
        .checked_sub(fee_bps)
        .ok_or(AapedError::MathOverflow)?;
    require!(denom > 0, AapedError::MathOverflow);

    // ceil(net * 10000 / (10000 - fee_bps))
    let num = net.checked_mul(10_000).ok_or(AapedError::MathOverflow)?;
    ceil_div(num, denom)
}

/// Constant product curve buy (unchanged)
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
pub fn curve_spot_tokens_per_lamport(sol_real: u128, tok_real: u128) -> Result<u128> {
    let r_sol = V_SOL.checked_add(sol_real).ok_or(error!(AapedError::MathOverflow))?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(error!(AapedError::MathOverflow))?;
    require!(r_sol > 0, AapedError::MathOverflow);
    Ok(r_tok
        .checked_div(r_sol)
        .ok_or(error!(AapedError::MathOverflow))?)
}

/// Binary search minimal sol_eff in [0, sol_eff_max] such that curve_buy(sol_eff) >= target_tokens
pub fn curve_sol_eff_for_exact_tokens(
    target_tokens: u128,
    sol_collected: u128,
    curve_inventory: u128,
    sol_eff_max: u128,
) -> Result<u128> {
    let mut lo: u128 = 0;
    let mut hi: u128 = sol_eff_max;

    while lo < hi {
        let mid = lo
            .checked_add(hi)
            .ok_or(AapedError::MathOverflow)?
            / 2;

        let (t_mid, _, _) = curve_buy(mid, sol_collected, curve_inventory, 0)?;
        if t_mid >= target_tokens {
            hi = mid;
        } else {
            lo = mid
                .checked_add(1)
                .ok_or(AapedError::MathOverflow)?;
        }
    }

    Ok(lo)
}

/// Tail buy at fixed rate (tokens per lamport), no extra fee inside.
/// tokens_out = sol_eff * rate
pub fn tail_buy_fixed(sol_eff: u128, rate_tokens_per_lamport: u128) -> Result<u128> {
    require!(rate_tokens_per_lamport > 0, AapedError::MathOverflow);
    sol_eff
        .checked_mul(rate_tokens_per_lamport)
        .ok_or(error!(AapedError::MathOverflow))
}

