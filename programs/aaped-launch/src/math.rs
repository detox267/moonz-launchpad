use crate::errors::MoonzError;
use anchor_lang::prelude::*;

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000; // 6 decimals

pub const V_SOL: u128 = 117 * LAMPORTS_PER_SOL;
pub const V_TOK: u128 = 760_000_000 * TOKEN_DECIMALS;

#[inline]
pub fn bps_amount(amount: u128, bps: u128) -> Result<u128> {
    let mul = amount
        .checked_mul(bps)
        .ok_or(error!(MoonzError::MathOverflow))?;
    Ok(mul
        .checked_div(10_000)
        .ok_or(error!(MoonzError::MathOverflow))?)
}

#[inline]
pub fn ceil_div(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, MoonzError::MathOverflow);

    let b_minus_1 = b.checked_sub(1).ok_or(error!(MoonzError::MathOverflow))?;

    let num = a
        .checked_add(b_minus_1)
        .ok_or(error!(MoonzError::MathOverflow))?;

    Ok(num.checked_div(b).ok_or(error!(MoonzError::MathOverflow))?)
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
        .ok_or(error!(MoonzError::MathOverflow))?;
    require!(denom > 0, MoonzError::MathOverflow);

    let num = net
        .checked_mul(10_000)
        .ok_or(error!(MoonzError::MathOverflow))?;

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
        .ok_or(error!(MoonzError::MathOverflow))?;

    let r_sol = V_SOL
        .checked_add(sol_real)
        .ok_or(error!(MoonzError::MathOverflow))?;
    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(MoonzError::MathOverflow))?;

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(MoonzError::MathOverflow))?;

    let r_sol_new = r_sol
        .checked_add(sol_eff)
        .ok_or(error!(MoonzError::MathOverflow))?;
    // Round the new token reserve up so integer division never gives
    // the buyer more tokens than the constant-product invariant permits.
    let r_tok_new = ceil_div(k, r_sol_new)?;

    let tokens_out = r_tok
        .checked_sub(r_tok_new)
        .ok_or(error!(MoonzError::MathOverflow))?;

    Ok((tokens_out, sol_eff, fee_total))
}

pub fn curve_sell_gross(tokens_in: u128, sol_real: u128, tok_real: u128) -> Result<u128> {
    let r_sol = V_SOL
        .checked_add(sol_real)
        .ok_or(error!(MoonzError::MathOverflow))?;

    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(MoonzError::MathOverflow))?;

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(MoonzError::MathOverflow))?;

    let r_tok_new = r_tok
        .checked_add(tokens_in)
        .ok_or(error!(MoonzError::MathOverflow))?;

    // Important:
    // For sells, use ceil division so we do not overpay SOL by 1-2 lamports
    // because of integer rounding.
    let r_sol_new = ceil_div(k, r_tok_new)?;

    Ok(r_sol
        .checked_sub(r_sol_new)
        .ok_or(error!(MoonzError::MathOverflow))?)
}

pub fn curve_sol_eff_for_exact_tokens_cp(
    target_tokens: u128,
    sol_collected: u128,
    tok_real: u128,
) -> Result<u128> {
    require!(target_tokens > 0, MoonzError::ZeroOutput);

    let r_sol = V_SOL
        .checked_add(sol_collected)
        .ok_or(error!(MoonzError::MathOverflow))?;
    let r_tok = V_TOK
        .checked_add(tok_real)
        .ok_or(error!(MoonzError::MathOverflow))?;

    require!(target_tokens < r_tok, MoonzError::InsufficientSaleLiquidity);

    let k = r_sol
        .checked_mul(r_tok)
        .ok_or(error!(MoonzError::MathOverflow))?;
    let r_tok_new = r_tok
        .checked_sub(target_tokens)
        .ok_or(error!(MoonzError::MathOverflow))?;

    // For exact-output buys, use ceil division so the buyer never receives
    // the remaining curve tokens for less quote than the constant-product invariant requires.
    let r_sol_new = ceil_div(k, r_tok_new)?;

    let sol_eff_needed = r_sol_new
        .checked_sub(r_sol)
        .ok_or(error!(MoonzError::MathOverflow))?;

    require!(sol_eff_needed > 0, MoonzError::InvalidAmount);
    Ok(sol_eff_needed)
}

/// AMM sell gross SOL output before fee split.
pub fn amm_sell_sol_out_gross(tokens_in: u128, x_sol: u128, y_tok: u128) -> Result<u128> {
    let k = x_sol
        .checked_mul(y_tok)
        .ok_or(error!(MoonzError::MathOverflow))?;
    let y_new = y_tok
        .checked_add(tokens_in)
        .ok_or(error!(MoonzError::MathOverflow))?;
    // Use ceil division so integer rounding never overpays quote output.
    let x_new = ceil_div(k, y_new)?;
    let sol_out = x_sol
        .checked_sub(x_new)
        .ok_or(error!(MoonzError::MathOverflow))?;
    Ok(sol_out)
}

pub fn amm_buy_tokens_out(sol_trade: u128, x_sol: u128, y_tok: u128) -> Result<u128> {
    let k = x_sol
        .checked_mul(y_tok)
        .ok_or(error!(MoonzError::MathOverflow))?;
    let x_new = x_sol
        .checked_add(sol_trade)
        .ok_or(error!(MoonzError::MathOverflow))?;
    // Use ceil division so integer rounding never overpays token output.
    let y_new = ceil_div(k, x_new)?;
    let out = y_tok
        .checked_sub(y_new)
        .ok_or(error!(MoonzError::MathOverflow))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_product_not_reduced(sol_real: u128, tok_real: u128, sol_eff: u128) {
        let r_sol = V_SOL + sol_real;
        let r_tok = V_TOK + tok_real;
        let k_before = r_sol * r_tok;

        let (tokens_out, used, fee) = curve_buy(sol_eff, sol_real, tok_real, 0).unwrap();
        assert_eq!(used, sol_eff);
        assert_eq!(fee, 0);
        assert!(tokens_out > 0);

        let r_sol_after = r_sol + sol_eff;
        let r_tok_after = r_tok - tokens_out;
        assert!(r_sol_after * r_tok_after >= k_before);
    }

    #[test]
    fn curve_buy_rounding_never_reduces_invariant() {
        for sol_real in [0, 1, 1_000_000, 100 * LAMPORTS_PER_SOL] {
            for tok_real in [1, TOKEN_DECIMALS, 650_000_000 * TOKEN_DECIMALS] {
                for sol_eff in [1, 10_000, 1_000_000, LAMPORTS_PER_SOL] {
                    assert_product_not_reduced(sol_real, tok_real, sol_eff);
                }
            }
        }
    }

    #[test]
    fn exact_output_buy_charges_enough_quote() {
        let tok_real = 650_000_000 * TOKEN_DECIMALS;
        let target = 1_000_000 * TOKEN_DECIMALS;
        let sol_eff = curve_sol_eff_for_exact_tokens_cp(target, 0, tok_real).unwrap();
        let (out, _, _) = curve_buy(sol_eff, 0, tok_real, 0).unwrap();
        assert!(out >= target);
    }

    #[test]
    fn curve_sell_never_overpays_invariant() {
        let sol_real = 50 * LAMPORTS_PER_SOL;
        let tok_real = 400_000_000 * TOKEN_DECIMALS;
        let tokens_in = 1_000_000 * TOKEN_DECIMALS;
        let out = curve_sell_gross(tokens_in, sol_real, tok_real).unwrap();

        let r_sol = V_SOL + sol_real;
        let r_tok = V_TOK + tok_real;
        let r_sol_after = r_sol - out;
        let r_tok_after = r_tok + tokens_in;
        assert!(r_sol_after * r_tok_after >= r_sol * r_tok);
    }

    #[test]
    fn amm_rounding_never_reduces_invariant() {
        let quote = 100 * LAMPORTS_PER_SOL;
        let tokens = 350_000_000 * TOKEN_DECIMALS;

        let bought = amm_buy_tokens_out(LAMPORTS_PER_SOL, quote, tokens).unwrap();
        assert!((quote + LAMPORTS_PER_SOL) * (tokens - bought) >= quote * tokens);

        let sold = 1_000_000 * TOKEN_DECIMALS;
        let quote_out = amm_sell_sol_out_gross(sold, quote, tokens).unwrap();
        assert!((quote - quote_out) * (tokens + sold) >= quote * tokens);
    }
}
