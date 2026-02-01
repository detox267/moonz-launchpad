use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{
    self, Mint, Token, TokenAccount, Transfer, MintTo, SetAuthority,
};
use anchor_spl::token::spl_token::instruction::AuthorityType;

mod state;
mod errors;
mod math;

use state::*;
use errors::*;
use math::*;

declare_id!("9rXdqU4PS9acsUVU8VsJ2zV3ejEV9JpYPiP1y7hSwuSm");

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        let mint_key = ctx.accounts.mint.key();

        // Create SOL vault PDAs
        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.treasury_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[b"treasury_sol", mint_key.as_ref(), &[ctx.bumps.treasury_sol_vault]],
        )?;

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.creator_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[b"creator_sol", mint_key.as_ref(), &[ctx.bumps.creator_sol_vault]],
        )?;

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.platform_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[b"platform_sol", mint_key.as_ref(), &[ctx.bumps.platform_sol_vault]],
        )?;

        let st = &mut ctx.accounts.launch_state;

        st.bump = ctx.bumps.launch_state;
        st.treasury_sol_bump = ctx.bumps.treasury_sol_vault;
        st.creator_sol_bump = ctx.bumps.creator_sol_vault;
        st.platform_sol_bump = ctx.bumps.platform_sol_vault;
        st.mint = mint_key;
        st.creator = params.creator;
        st.platform = params.platform;
        st.state = LaunchPhase::Curve as u8;

        st.total_supply = params.total_supply;
        st.sale_supply = params.sale_supply;
        st.lp_supply = params.lp_supply;

        st.v_sol = params.v_sol;
        st.v_tok = params.v_tok;

        st.tail_start = params.tail_start;
        st.tail_end = params.tail_end;
        st.migration_sol_target = params.migration_sol_target;

        st.fee_total_bps = params.fee_total_bps;
        st.fee_creator_bps = params.fee_creator_bps;
        st.fee_platform_bps = params.fee_platform_bps;
        st.fee_lp_growth_bps = params.fee_lp_growth_bps;

        st.tokens_sold = 0;
        st.sol_collected = 0;

        st.sale_vault = ctx.accounts.sale_vault.key();
        st.lp_vault = ctx.accounts.lp_vault.key();
        st.treasury_sol_vault = ctx.accounts.treasury_sol_vault.key();
        st.creator_sol_vault = ctx.accounts.creator_sol_vault.key();
        st.platform_sol_vault = ctx.accounts.platform_sol_vault.key();

        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.mint_receiver.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            st.total_supply,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mint_receiver.to_account_info(),
                    to: ctx.accounts.sale_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            st.sale_supply,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.mint_receiver.to_account_info(),
                    to: ctx.accounts.lp_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            st.lp_supply,
        )?;

        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            AuthorityType::FreezeAccount,
            None,
        )?;

        let now = Clock::get()?.unix_timestamp;
        st.launch_ts = now;
        st.last_trade_ts = now;

        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64) -> Result<()> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    // ----- Vault safety checks FIRST (no state borrow issues) -----
    {
        let st_ro = &ctx.accounts.launch_state;
        require_keys_eq!(
            ctx.accounts.treasury_sol_vault.key(),
            st_ro.treasury_sol_vault,
            AapedError::InvalidVault
        );
        require_keys_eq!(
            ctx.accounts.creator_sol_vault.key(),
            st_ro.creator_sol_vault,
            AapedError::InvalidVault
        );
        require_keys_eq!(
            ctx.accounts.platform_sol_vault.key(),
            st_ro.platform_sol_vault,
            AapedError::InvalidVault
        );
    }

    // ----- Copy out PDA seed material BEFORE mutable borrow -----
    let launch_ai = ctx.accounts.launch_state.to_account_info();
    let mint: Pubkey = ctx.accounts.launch_state.mint;
    let bump: u8 = ctx.accounts.launch_state.bump;
    let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

    // ----- Now mutable state handle -----
    let st = &mut ctx.accounts.launch_state;

    // Disallow buys if migration already pending/migrated
    require!(
        st.state == LaunchPhase::Curve as u8 || st.state == LaunchPhase::Tail as u8,
        AapedError::InvalidState
    );

    let sale_remaining: u128 = ctx.accounts.sale_vault.amount as u128;
    require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);

    let sol_in_max: u128 = sol_in as u128;

    // ----------------------------
    // A) Determine curve cap remaining (tokens allowed on curve)
    // ----------------------------
    let tokens_sold_u128 = st.tokens_sold as u128;
    let tail_start_u128 = st.tail_start as u128;

    let curve_cap_remaining: u128 = if tokens_sold_u128 >= tail_start_u128 {
        0
    } else {
        tail_start_u128
            .checked_sub(tokens_sold_u128)
            .ok_or(AapedError::MathOverflow)?
    };

    // curve inventory is min(curve cap, vault remaining)
    let curve_inventory: u128 = core::cmp::min(curve_cap_remaining, sale_remaining);

    // tail inventory is whatever is left after curve allowance
    let tail_inventory: u128 = sale_remaining
        .checked_sub(curve_inventory)
        .ok_or(AapedError::MathOverflow)?;

    let base_fee_bps: u128 = st.fee_total_bps as u128;
    let plat_bps: u128 = st.fee_platform_bps as u128;
    let lp_bps: u128 = st.fee_lp_growth_bps as u128;

    // net SOL max after base fee (assuming full sol_in_max)
    let base_fee_max = bps_amount(sol_in_max, base_fee_bps)?;
    let sol_eff_max = sol_in_max
        .checked_sub(base_fee_max)
        .ok_or(AapedError::MathOverflow)?;

    // ----------------------------
    // C) Compute tokens_out + sol_eff_used_total with partial fills
    // ----------------------------
    let mut tokens_out_total: u128 = 0;
    let mut sol_eff_used_total: u128 = 0;
    let mut sol_eff_used_on_curve: u128 = 0;

    // Helper: ensure tail price is set (continuity)
    // Tail price should be set exactly when we first cross into tail.
    // If state already Tail and price not set, we set it from current spot.
    let mut tail_rate: u128 = st.tail_price_tokens_per_lamport;
    if st.state == LaunchPhase::Tail as u8 && tail_rate == 0 {
        // best effort: current spot assuming tok_real=0 in tail regime
        tail_rate = curve_spot_tokens_per_lamport(st.sol_collected, 0)?;
        st.tail_price_tokens_per_lamport = tail_rate;
    }

    if st.state == LaunchPhase::Tail as u8 || curve_inventory == 0 {
        // ----------------------------
        // Tail-only
        // ----------------------------
        require!(tail_rate > 0, AapedError::MathOverflow);

        let wanted = tail_buy_fixed(sol_eff_max, tail_rate)?;
        if wanted <= sale_remaining {
            tokens_out_total = wanted;
            sol_eff_used_total = sol_eff_max;
            sol_eff_used_on_curve = 0;
        } else {
            // Partial tail fill: drain remaining tokens
            tokens_out_total = sale_remaining;

            // sol_eff_needed = ceil(tokens / rate)
            let sol_eff_needed = ceil_div(tokens_out_total, tail_rate)?;
            sol_eff_used_total = sol_eff_needed;
            sol_eff_used_on_curve = 0;

            // Move to migration pending once sold out
            st.state = LaunchPhase::MigrationPending as u8;
        }
    } else {
        // ----------------------------
        // Curve-first, may cross into Tail
        // ----------------------------
        let (curve_wanted, _, _) = curve_buy(sol_eff_max, st.sol_collected, curve_inventory, 0)?;
        require!(curve_wanted > 0, AapedError::ZeroOutput);

        if curve_wanted <= curve_inventory {
            // Fully on curve
            tokens_out_total = curve_wanted;
            sol_eff_used_total = sol_eff_max;
            sol_eff_used_on_curve = sol_eff_max;
        } else {
            // Cross boundary:
            // 1) drain curve_inventory at curve price
            let sol_on_curve = curve_sol_eff_for_exact_tokens_cp(
            curve_inventory,
            st.sol_collected,
            0, // tok_real (your model uses 0)
            )?;

            sol_eff_used_on_curve = sol_on_curve;

            let sol_left = sol_eff_max
                .checked_sub(sol_on_curve)
                .ok_or(AapedError::MathOverflow)?;

            // 2) Determine terminal curve spot price AT the boundary.
            // boundary sol_collected is current + sol_on_curve (we will add this later)
            let boundary_sol_collected = st.sol_collected
                .checked_add(sol_on_curve)
                .ok_or(AapedError::MathOverflow)?;

            let boundary_tail_rate = curve_spot_tokens_per_lamport(boundary_sol_collected, 0)?;
            require!(boundary_tail_rate > 0, AapedError::MathOverflow);

            // Store once
            if st.tail_price_tokens_per_lamport == 0 {
                st.tail_price_tokens_per_lamport = boundary_tail_rate;
            }

            tail_rate = st.tail_price_tokens_per_lamport;

            // tail desired
            let tail_wanted = tail_buy_fixed(sol_left, tail_rate)?;

            if tail_wanted <= tail_inventory {
                // full remaining sol_left used
                tokens_out_total = curve_inventory
                    .checked_add(tail_wanted)
                    .ok_or(AapedError::MathOverflow)?;
                sol_eff_used_total = sol_eff_max;

                // we are now in Tail
                st.state = LaunchPhase::Tail as u8;
            } else {
                // partial tail fill: drain tail inventory too
                let tail_tokens_out = tail_inventory;

                let sol_tail_needed = ceil_div(tail_tokens_out, tail_rate)?;
                let sol_eff_used = sol_on_curve
                    .checked_add(sol_tail_needed)
                    .ok_or(AapedError::MathOverflow)?;

                tokens_out_total = curve_inventory
                    .checked_add(tail_tokens_out)
                    .ok_or(AapedError::MathOverflow)?;
                sol_eff_used_total = sol_eff_used;

                // Sold out completely => migration pending
                st.state = LaunchPhase::MigrationPending as u8;
            }
        }
    }

    require!(tokens_out_total > 0, AapedError::ZeroOutput);
    require!(tokens_out_total <= sale_remaining, AapedError::InsufficientSaleLiquidity);

    // ----------------------------
    // D) Convert used NET back to used GROSS for correct fee + transfers
    // ----------------------------
    // gross_used is the amount of "sol_in" actually charged (<= sol_in_max)
    let sol_in_used = gross_from_net(sol_eff_used_total, base_fee_bps)?;
    require!(sol_in_used <= sol_in_max, AapedError::MathOverflow);

    let base_fee_used = sol_in_used
        .checked_sub(sol_eff_used_total)
        .ok_or(AapedError::MathOverflow)?;

    let platform_fee_used = bps_amount(sol_in_used, plat_bps)?;
    require!(platform_fee_used <= base_fee_used, AapedError::MathOverflow);

    let creator_fee_used = base_fee_used
        .checked_sub(platform_fee_used)
        .ok_or(AapedError::MathOverflow)?;

    let lp_fee_used = bps_amount(sol_in_used, lp_bps)?;

    // Track LP growth bucket (based on USED amount)
    st.lp_growth_sol = st.lp_growth_sol
        .checked_add(lp_fee_used)
        .ok_or(AapedError::MathOverflow)?;

    // Treasury gets net curve+tail SOL used + lp_fee_used
    let treasury_amount = sol_eff_used_total
        .checked_add(lp_fee_used)
        .ok_or(AapedError::MathOverflow)?;

    // ----------------------------
    // E) SOL transfers (ONLY USED amounts; unused stays with buyer)
    // ----------------------------
    if creator_fee_used > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.creator_sol_vault.to_account_info(),
                },
            ),
            creator_fee_used as u64,
        )?;
    }

    if platform_fee_used > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.platform_sol_vault.to_account_info(),
                },
            ),
            platform_fee_used as u64,
        )?;
    }

    if treasury_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury_sol_vault.to_account_info(),
                },
            ),
            treasury_amount as u64,
        )?;
    }

    // ----------------------------
    // F) Token transfer out
    // ----------------------------
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sale_vault.to_account_info(),
                to: ctx.accounts.buyer_ata.to_account_info(),
                authority: launch_ai,
            },
            &[signer_seeds],
        ),
        tokens_out_total as u64,
    )?;

    // ----------------------------
    // G) Update accounting
    // ----------------------------
    st.tokens_sold = st.tokens_sold
        .checked_add(tokens_out_total as u64)
        .ok_or(AapedError::MathOverflow)?;

    // sol_collected only tracks curve progression:
    st.sol_collected = st.sol_collected
        .checked_add(sol_eff_used_on_curve)
        .ok_or(AapedError::MathOverflow)?;

    st.last_trade_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

pub fn sell(ctx: Context<Sell>, tokens_in: u64) -> Result<()> {
    require!(tokens_in > 0, AapedError::InvalidAmount);

    // ---- vault safety
    {
        let st_ro = &ctx.accounts.launch_state;
        require_keys_eq!(ctx.accounts.treasury_sol_vault.key(), st_ro.treasury_sol_vault, AapedError::InvalidVault);
        require_keys_eq!(ctx.accounts.creator_sol_vault.key(), st_ro.creator_sol_vault, AapedError::InvalidVault);
        require_keys_eq!(ctx.accounts.platform_sol_vault.key(), st_ro.platform_sol_vault, AapedError::InvalidVault);
    }

    let mint = ctx.accounts.launch_state.mint;
    let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;
    let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

    let st = &mut ctx.accounts.launch_state;

    // sells only on curve
    require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

    // seller has tokens
    require!(
        ctx.accounts.seller_ata.amount >= tokens_in,
        AapedError::InsufficientSaleLiquidity
    );

    // ---- invariant math
    let sol_real = st.sol_collected as u128;
    let tok_real = 0u128;

    let sol_gross = curve_sell_gross(tokens_in as u128, sol_real, tok_real)?;
    require!(sol_gross > 0, AapedError::ZeroOutput);

    // ---- fees
    let base_fee = bps_amount(sol_gross, st.fee_total_bps as u128)?;
    let lp_fee   = bps_amount(sol_gross, st.fee_lp_growth_bps as u128)?;
    let platform_fee = bps_amount(sol_gross, st.fee_platform_bps as u128)?;
    let creator_fee = base_fee
        .checked_sub(platform_fee)
        .ok_or(AapedError::MathOverflow)?;

    let sol_net = sol_gross
        .checked_sub(base_fee)?
        .checked_sub(lp_fee)?;

    // treasury must cover payout
    let treasury_lamports = ctx.accounts.treasury_sol_vault.lamports() as u128;
    require!(treasury_lamports >= sol_gross, AapedError::InsufficientTreasuryLiquidity);

    // ---- token back to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.seller_ata.to_account_info(),
                to: ctx.accounts.sale_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        tokens_in,
    )?;

    // ---- SOL payouts
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.treasury_sol_vault.to_account_info(),
                to: ctx.accounts.seller.to_account_info(),
            },
            &[treasury_seeds],
        ),
        sol_net as u64,
    )?;

    if creator_fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.treasury_sol_vault.to_account_info(),
                    to: ctx.accounts.creator_sol_vault.to_account_info(),
                },
                &[treasury_seeds],
            ),
            creator_fee as u64,
        )?;
    }

    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.treasury_sol_vault.to_account_info(),
                    to: ctx.accounts.platform_sol_vault.to_account_info(),
                },
                &[treasury_seeds],
            ),
            platform_fee as u64,
        )?;
    }

    // ---- accounting
    st.tokens_sold = st.tokens_sold.checked_sub(tokens_in)?;
    st.sol_collected = st.sol_collected.checked_sub(sol_gross as u64)?;
    st.lp_growth_sol = st.lp_growth_sol.checked_add(lp_fee as u64)?;
    st.last_trade_ts = Clock::get()?.unix_timestamp;

      Ok(())
    }
}

fn create_pda_system_account<'info>(
    payer: &Signer<'info>,
    pda: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    if pda.to_account_info().lamports() > 0 {
        return Ok(());
    }

    let lamports = rent.minimum_balance(space);

    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            system_program::CreateAccount {
                from: payer.to_account_info(),
                to: pda.to_account_info(),
            },
            &[seeds],
        ),
        lamports,
        space as u64,
        &system_program::ID,
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub mint_receiver: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = LaunchState::LEN,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    #[account(init, payer = payer, token::mint = mint, token::authority = launch_state)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(init, payer = payer, token::mint = mint, token::authority = launch_state)]
    pub lp_vault: Account<'info, TokenAccount>,

/// CHECK: PDA owned by SystemProgram used as SOL vault
#[account(mut, seeds = [b"treasury_sol", mint.key().as_ref()], bump)]
pub treasury_sol_vault: UncheckedAccount<'info>,

/// CHECK: PDA owned by SystemProgram used as SOL vault
#[account(mut, seeds = [b"creator_sol", mint.key().as_ref()], bump)]
pub creator_sol_vault: UncheckedAccount<'info>,

/// CHECK: PDA owned by SystemProgram used as SOL vault
#[account(mut, seeds = [b"platform_sol", mint.key().as_ref()], bump)]
pub platform_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, has_one = sale_vault)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields in instruction.
    #[account(mut)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields in instruction.
    #[account(mut)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields in instruction.
    #[account(mut)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut, has_one = sale_vault)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_ata: Account<'info, TokenAccount>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields
    #[account(mut)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields
    #[account(mut)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK: PDA system account used as SOL vault; verified against launch_state fields
    #[account(mut)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

