use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, SetAuthority};
use spl_token::instruction::AuthorityType;

mod state;
mod errors;
mod math;

use state::*;
use errors::*;
use math::*;

declare_id!("AaPeD111111111111111111111111111111111111111");

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        let st = &mut ctx.accounts.launch_state;

        st.bump = ctx.bumps.launch_state;
        st.mint = ctx.accounts.mint.key();
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

        // 1) Mint total supply to mint_receiver (owned by mint_authority)
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

        // 2) Split to sale + lp vaults
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

        // 3) Revoke mint authority
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

        // 4) Revoke freeze authority
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

        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64) -> Result<()> {
        require!(sol_in > 0, AapedError::InvalidAmount);

        let st = &mut ctx.accounts.launch_state;
        require!(st.state != LaunchPhase::Migrated as u8, AapedError::AlreadyMigrated);

        let remaining_u64 = ctx.accounts.sale_vault.amount;
        let remaining: u128 = remaining_u64 as u128;

        // Move to Tail based on remaining sale tokens
        if st.state == LaunchPhase::Curve as u8 && remaining <= st.tail_start as u128 {
            st.state = LaunchPhase::Tail as u8;
        }

        // Compute fee splits from SOL input (bps)
        let fee_creator_u64 = bps_u64(sol_in, st.fee_creator_bps)?;
        let fee_platform_u64 = bps_u64(sol_in, st.fee_platform_bps)?;
        let fee_lp_growth_u64 = bps_u64(sol_in, st.fee_lp_growth_bps)?;
        let fee_total_u64 = bps_u64(sol_in, st.fee_total_bps)?;

        // Sanity check: buckets <= total fee (rounding safe)
        let sum_buckets = fee_creator_u64
            .checked_add(fee_platform_u64).ok_or(AapedError::MathOverflow)?
            .checked_add(fee_lp_growth_u64).ok_or(AapedError::MathOverflow)?;
        require!(sum_buckets <= fee_total_u64, AapedError::FeeConfigInvalid);

        let sol_in_u128: u128 = sol_in as u128;

        // Token quote (u128)
        let tokens_out_u128: u128;

        if st.state == LaunchPhase::Tail as u8 {
            // Tail: fixed anchor price at migration ratio (fee applied inside tail_buy)
            let (tokens_out, _sol_eff, _fee_total) = tail_buy(sol_in_u128)?;
            tokens_out_u128 = tokens_out;
        } else {
            // Curve: use synthetic reserves
            // sol_real = st.sol_collected (we track curve reserve sol in this variable)
            // tok_real = remaining in sale vault
            let (tokens_out, _sol_eff, _fee_total) = curve_buy(sol_in_u128, st.sol_collected, remaining)?;
            tokens_out_u128 = tokens_out;
        }

        require!(tokens_out_u128 > 0, AapedError::ZeroOutput);
        require!(tokens_out_u128 <= remaining, AapedError::InsufficientSaleLiquidity);
        require!(tokens_out_u128 <= u64::MAX as u128, AapedError::MathOverflow);

        let tokens_out: u64 = tokens_out_u128 as u64;

        // Route SOL:
        // - creator fee
        // - platform fee
        // - lp_growth fee (to treasury for now)
        // - net remainder to treasury
        let net_to_treasury = (sol_in as u128)
            .checked_sub(fee_creator_u64 as u128).ok_or(AapedError::MathOverflow)?
            .checked_sub(fee_platform_u64 as u128).ok_or(AapedError::MathOverflow)?
            .checked_sub(fee_lp_growth_u64 as u128).ok_or(AapedError::MathOverflow)?;

        require!(net_to_treasury <= u64::MAX as u128, AapedError::MathOverflow);

        transfer_lamports(&ctx.accounts.buyer, &ctx.accounts.creator_sol_vault, fee_creator_u64)?;
        transfer_lamports(&ctx.accounts.buyer, &ctx.accounts.platform_sol_vault, fee_platform_u64)?;
        transfer_lamports(&ctx.accounts.buyer, &ctx.accounts.treasury_sol_vault, fee_lp_growth_u64)?;
        transfer_lamports(&ctx.accounts.buyer, &ctx.accounts.treasury_sol_vault, net_to_treasury as u64)?;

        // Transfer tokens out (program signs)
        let signer_seeds: &[&[u8]] = &[
            b"launch_state",
            st.mint.as_ref(),
            &[st.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.launch_state.to_account_info(),
                },
                &[signer_seeds],
            ),
            tokens_out,
        )?;

        // Accounting updates:
        // - tokens sold increases
        st.tokens_sold = st.tokens_sold
            .checked_add(tokens_out).ok_or(AapedError::MathOverflow)?;

        // - curve reserve SOL tracking:
        //   We track reserve SOL as (sol_in - creator - platform) because LP growth stays in reserve side.
        //   That matches your fee model (creator/platform siphoned, LP growth stays).
        let reserve_add = (sol_in as u128)
            .checked_sub(fee_creator_u64 as u128).ok_or(AapedError::MathOverflow)?
            .checked_sub(fee_platform_u64 as u128).ok_or(AapedError::MathOverflow)?;

        st.sol_collected = st.sol_collected
            .checked_add(reserve_add).ok_or(AapedError::MathOverflow)?;

        Ok(())
    }
}

/// Simple lamports transfer (mut lamports) for SystemAccount/AccountInfo you own.
fn transfer_lamports(from: &Signer, to: &AccountInfo, lamports: u64) -> Result<()> {
    require!(lamports > 0, AapedError::InvalidAmount);

    **from.to_account_info().try_borrow_mut_lamports()? =
        from.to_account_info()
            .lamports()
            .checked_sub(lamports)
            .ok_or(AapedError::MathOverflow)?;

    **to.try_borrow_mut_lamports()? =
        to.lamports()
            .checked_add(lamports)
            .ok_or(AapedError::MathOverflow)?;

    Ok(())
}

/// -------------------- ACCOUNTS --------------------

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// one-time mint authority that currently controls the mint
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// Temporary receiver owned by mint_authority (must exist).
    #[account(
        mut,
        constraint = mint_receiver.mint == mint.key(),
        constraint = mint_receiver.owner == mint_authority.key(),
    )]
    pub mint_receiver: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = LaunchState::LEN,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = launch_state
    )]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = launch_state
    )]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"treasury_sol", mint.key().as_ref()],
        bump
    )]
    pub treasury_sol_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"creator_sol", mint.key().as_ref()],
        bump
    )]
    pub creator_sol_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"platform_sol", mint.key().as_ref()],
        bump
    )]
    pub platform_sol_vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump,
        has_one = sale_vault
    )]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: AccountInfo<'info>,
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: AccountInfo<'info>,
    #[account(mut, address = launch_state.platform_sol_vault)]
    pub platform_sol_vault: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}
