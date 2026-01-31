use anchor_lang::prelude::*;
use crate::errors::AapedError;

/// ----- CONSTANTS (base units) -----
pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const TOKEN_DECIMALS: u128 = 1_000_000; // 6 decimals

pub const V_SOL: u128 = 30 * LAMPORTS_PER_SOL;
pub const V_TOK: u128 = 526_200_000 * TOKEN_DECIMALS;

pub const SALE_TOTAL: u128 = 600_000_000 * TOKEN_DECIMALS;

pub const TAIL_START_REMAIN: u128 = 15_000_000 * TOKEN_DECIMALS;
pub const TAIL_END_REMAIN: u128 = 5_000_000 * TOKEN_DECIMALS;

pub const MIGRATION_SOL_TARGET: u128 = 85 * LAMPORTS_PER_SOL;
pub const LP_TOTAL: u128 = 400_000_000 * TOKEN_DECIMALS;

// Fees (bps)
pub const FEE_TOTAL_BPS: u128 = 125;      // 1.25% total (matches your spec)
pub const FEE_CREATOR_BPS: u128 = 80;     // 0.80%
pub const FEE_PLATFORM_BPS: u128 = 20;    // 0.20%
pub const FEE_LP_GROWTH_BPS: u128 = 25;   // 0.25%

#[inline]
pub fn bps_u128(amount: u128, bps: u128) -> Result<u128> {
    amount
        .checked_mul(bps).ok_or(AapedError::MathOverflow)?
        .checked_div(10_000).ok_or(AapedError::MathOverflow)
}

#[inline]
pub fn bps_u64(amount: u64, bps: u16) -> Result<u64> {
    let out = (amount as u128)
        .checked_mul(bps as u128).ok_or(AapedError::MathOverflow)?
        .checked_div(10_000).ok_or(AapedError::MathOverflow)?;
    Ok(out as u64)
}

/// Curve buy:
/// Inputs:
/// - sol_in: lamports user sends in (u128)
/// - sol_real: real SOL reserve accumulated into the curve reserve (u128)
/// - tok_real: real tokens available for sale remaining (u128)
///
/// Model:
/// r_sol = V_SOL + sol_real
/// r_tok = V_TOK + tok_real
/// k = r_sol * r_tok
///
/// fee_total taken on sol_in
/// sol_eff = sol_in - fee_total
///
/// r_sol_new = r_sol + sol_eff
/// r_tok_new = k / r_sol_new
/// tokens_out = r_tok - r_tok_new
///
/// Returns: (tokens_out, sol_eff, fee_total)
pub fn curve_buy(sol_in: u128, sol_real: u128, tok_real: u128) -> Result<(u128, u128, u128)> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    // fee on input
    let fee_total = bps_u128(sol_in, FEE_TOTAL_BPS)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(AapedError::MathOverflow)?;

    let r_sol = V_SOL.checked_add(sol_real).ok_or(AapedError::MathOverflow)?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(AapedError::MathOverflow)?;

    let k = r_sol.checked_mul(r_tok).ok_or(AapedError::MathOverflow)?;

    let r_sol_new = r_sol.checked_add(sol_eff).ok_or(AapedError::MathOverflow)?;
    let r_tok_new = k.checked_div(r_sol_new).ok_or(AapedError::MathOverflow)?;

    let tokens_out = r_tok.checked_sub(r_tok_new).ok_or(AapedError::MathOverflow)?;

    Ok((tokens_out, sol_eff, fee_total))
}

pub fn curve_sell(tokens_in: u128, sol_real: u128, tok_real: u128) -> Result<(u128, u128, u128)> {
    require!(tokens_in > 0, AapedError::InvalidAmount);

    let r_sol = V_SOL.checked_add(sol_real).ok_or(AapedError::MathOverflow)?;
    let r_tok = V_TOK.checked_add(tok_real).ok_or(AapedError::MathOverflow)?;
    let k = r_sol.checked_mul(r_tok).ok_or(AapedError::MathOverflow)?;

    let r_tok_new = r_tok.checked_add(tokens_in).ok_or(AapedError::MathOverflow)?;
    let r_sol_new = k.checked_div(r_tok_new).ok_or(AapedError::MathOverflow)?;

    let sol_gross = r_sol.checked_sub(r_sol_new).ok_or(AapedError::MathOverflow)?;

    let fee_total = bps_u128(sol_gross, FEE_TOTAL_BPS)?;
    let sol_net = sol_gross.checked_sub(fee_total).ok_or(AapedError::MathOverflow)?;

    Ok((sol_gross, fee_total, sol_net))
}

pub fn tail_buy(sol_in: u128) -> Result<(u128, u128, u128)> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    let fee_total = bps_u128(sol_in, FEE_TOTAL_BPS)?;
    let sol_eff = sol_in.checked_sub(fee_total).ok_or(AapedError::MathOverflow)?;

    let tokens_out = sol_eff
        .checked_mul(LP_TOTAL).ok_or(AapedError::MathOverflow)?
        .checked_div(MIGRATION_SOL_TARGET).ok_or(AapedError::MathOverflow)?;

    Ok((tokens_out, sol_eff, fee_total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bps_u128() {
        assert_eq!(bps_u128(10_000, 100).unwrap(), 100); // 1%
        assert_eq!(bps_u128(1_000_000_000, 125).unwrap(), 12_500_000); // 1.25%
    }

    #[test]
    fn curve_buy_charges_fee_and_outputs_tokens() {
        let sol_in = 1 * LAMPORTS_PER_SOL;
        let sol_real = 0u128;
        let tok_real = SALE_TOTAL;

        let (tokens_out, sol_eff, fee_total) = curve_buy(sol_in, sol_real, tok_real).unwrap();

        assert_eq!(fee_total, 12_500_000); // 1.25% of 1 SOL
        assert_eq!(sol_eff, sol_in - fee_total);
        assert!(tokens_out > 0);
        assert!(tokens_out < V_TOK + tok_real);
    }

    #[test]
    fn curve_sell_charges_fee_and_outputs_sol() {
        let tokens_in = 1 * TOKEN_DECIMALS;
        let sol_real = 0u128;
        let tok_real = SALE_TOTAL;

        let (sol_gross, fee_total, sol_net) = curve_sell(tokens_in, sol_real, tok_real).unwrap();

        assert!(sol_gross > 0);
        assert!(fee_total > 0);
        assert_eq!(sol_net + fee_total, sol_gross);
    }

    #[test]
    fn tail_buy_matches_lp_anchor_price() {
        let sol_in = 85 * LAMPORTS_PER_SOL;
        let (tokens_out, sol_eff, fee_total) = tail_buy(sol_in).unwrap();

        assert_eq!(sol_eff + fee_total, sol_in);
        assert!(tokens_out > 0);

        let ideal = 400_000_000u128 * TOKEN_DECIMALS;
        assert!(tokens_out < ideal);
        assert!(tokens_out > ideal * 97 / 100);
    }
}
