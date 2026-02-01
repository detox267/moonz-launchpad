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

    let st = &mut ctx.accounts.launch_state;

    // vault safety checks (make sure client passed the correct PDAs)
    require_keys_eq!(
        ctx.accounts.treasury_sol_vault.key(),
        st.treasury_sol_vault,
        AapedError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.creator_sol_vault.key(),
        st.creator_sol_vault,
        AapedError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.platform_sol_vault.key(),
        st.platform_sol_vault,
        AapedError::InvalidVault
    );

    // signer seeds for launch_state PDA authority
    let launch_ai = st.to_account_info();
    let mint = st.mint;
    let bump = st.bump;
    let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

    // How many tokens exist in the sale vault total (curve+tail both come from here)
    let sale_vault_remaining: u128 = ctx.accounts.sale_vault.amount as u128;
    require!(sale_vault_remaining > 0, AapedError::InsufficientSaleLiquidity);

    // ----------------------------
    // 1) Fee math (apply ONCE)
    // ----------------------------
    let sol_in_u128 = sol_in as u128;

    // base trade fee (taken from sol_in)
    let fee_total = bps_amount(sol_in_u128, st.fee_total_bps as u128)?;

    // platform fee is a portion of sol_in; creator fee is remainder of fee_total
    let platform_fee = bps_amount(sol_in_u128, st.fee_platform_bps as u128)?;
    require!(platform_fee <= fee_total, AapedError::MathOverflow);

    let creator_fee = fee_total
        .checked_sub(platform_fee)
        .ok_or(AapedError::MathOverflow)?;

    // net SOL that counts toward curve progression
    let sol_eff_total = sol_in_u128
        .checked_sub(fee_total)
        .ok_or(AapedError::MathOverflow)?;

    // LP growth fee is EXTRA on top of sol_in (your design)
    let lp_fee = bps_amount(sol_in_u128, st.fee_lp_growth_bps as u128)?;

    // track LP growth bucket
    st.lp_growth_sol = st.lp_growth_sol
        .checked_add(lp_fee)
        .ok_or(AapedError::MathOverflow)?;

    // ----------------------------
    // 2) Pricing with partial fills
    // ----------------------------
    // Curve is only allowed to sell until tail_start is reached.
    // Anything after that must be priced using tail_buy.
    //
    // Note: tokens_sold is base-units (u64), tail_start is BN you pass in base-units.
    let tokens_sold_u128 = st.tokens_sold as u128;

    // How many tokens are STILL allowed to be sold on curve, based on tail_start cap?
    let curve_cap_remaining: u128 = if tokens_sold_u128 >= st.tail_start as u128 {
        0
    } else {
        (st.tail_start as u128)
            .checked_sub(tokens_sold_u128)
            .ok_or(AapedError::MathOverflow)?
    };

    // Actual curve-available inventory is min(curve_cap_remaining, sale_vault_remaining)
    let curve_inventory: u128 = core::cmp::min(curve_cap_remaining, sale_vault_remaining);

    // tail inventory is whatever is left in sale vault after curve inventory is conceptually reserved
    // (we don't physically split vaults; this is just math)
    let tail_inventory: u128 = sale_vault_remaining
        .checked_sub(curve_inventory)
        .ok_or(AapedError::MathOverflow)?;

    // Determine token output
    let mut tokens_out_total: u128 = 0;
    let mut sol_eff_used_on_curve: u128 = 0;
    let mut sol_eff_used_on_tail: u128 = 0;

    if st.state == LaunchPhase::Tail as u8 || curve_inventory == 0 {
        // Entire buy is tail-priced
        let (t_tail, _, _) = tail_buy(sol_eff_total, 0)?; // fee_bps=0 (fees already handled)
        require!(t_tail > 0, AapedError::ZeroOutput);
        require!(t_tail <= sale_vault_remaining, AapedError::InsufficientSaleLiquidity);

        tokens_out_total = t_tail;
        sol_eff_used_on_tail = sol_eff_total;

        // Ensure state is Tail
        st.state = LaunchPhase::Tail as u8;
    } else {
        // Curve-first pricing
        let (t_curve_wanted, _, _) = curve_buy(sol_eff_total, st.sol_collected, curve_inventory, 0)?;
        require!(t_curve_wanted > 0, AapedError::ZeroOutput);

        if t_curve_wanted <= curve_inventory {
            // Entire buy fits in curve allowance
            tokens_out_total = t_curve_wanted;
            sol_eff_used_on_curve = sol_eff_total;
        } else {
            // PARTIAL FILL:
            // 1) drain curve_inventory at curve price
            // 2) remaining sol_eff_total goes to tail price
            let curve_tokens_out = curve_inventory;

            // Find how much sol_eff is required to buy exactly curve_inventory tokens on curve.
            sol_eff_used_on_curve = curve_sol_eff_for_exact_tokens(
                curve_tokens_out,
                st.sol_collected,
                curve_inventory,
                sol_eff_total,
            )?;

            // remaining SOL_eff goes to tail
            sol_eff_used_on_tail = sol_eff_total
                .checked_sub(sol_eff_used_on_curve)
                .ok_or(AapedError::MathOverflow)?;

            let (t_tail, _, _) = tail_buy(sol_eff_used_on_tail, 0)?;
            require!(t_tail > 0, AapedError::ZeroOutput);

            // Must not exceed remaining tail inventory in sale vault
            require!(t_tail <= tail_inventory, AapedError::InsufficientSaleLiquidity);

            tokens_out_total = curve_tokens_out
                .checked_add(t_tail)
                .ok_or(AapedError::MathOverflow)?;

            // We crossed into tail, set state
            st.state = LaunchPhase::Tail as u8;
        }
    }

    require!(tokens_out_total > 0, AapedError::ZeroOutput);
    require!(tokens_out_total <= sale_vault_remaining, AapedError::InsufficientSaleLiquidity);

    let tokens_out_u64 = tokens_out_total as u64;

    // ----------------------------
    // 3) SOL transfers
    // ----------------------------
    if creator_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.creator_sol_vault.to_account_info(),
                },
            ),
            creator_fee as u64,
        )?;
    }

    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.platform_sol_vault.to_account_info(),
                },
            ),
            platform_fee as u64,
        )?;
    }

    // treasury gets net SOL (sol_eff_total) + lp_fee
    let treasury_amount = sol_eff_total
        .checked_add(lp_fee)
        .ok_or(AapedError::MathOverflow)?;

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
    // 4) Token transfer out (single CPI)
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
        tokens_out_u64,
    )?;

    // ----------------------------
    // 5) Update state accounting
    // ----------------------------
    st.tokens_sold = st.tokens_sold
        .checked_add(tokens_out_u64)
        .ok_or(AapedError::MathOverflow)?;

    // sol_collected tracks curve progression: we add ONLY the portion of sol_eff that was curve-priced.
    // If buy is fully curve: sol_eff_total
    // If partial: sol_eff_used_on_curve
    // If fully tail: 0 (curve progression no longer matters)
    st.sol_collected = st.sol_collected
        .checked_add(sol_eff_used_on_curve as u64)
        .ok_or(AapedError::MathOverflow)?;

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
