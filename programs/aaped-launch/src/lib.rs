use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod math;

use crate::errors::*;
use crate::state::*;
use crate::math::*;

use anchor_lang::system_program;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar;

use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;

// Metaplex
use mpl_token_metadata;

declare_id!("9rXdqU4PS9acsUVU8VsJ2zV3ejEV9JpYPiP1y7hSwuSm");

// -------------------- CONSTANTS --------------------
// Hardcoded platform wallet (your request)
use anchor_lang::prelude::pubkey;
pub const PLATFORM_WALLET: Pubkey = pubkey!("BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL");

#[program]
pub mod aaped_launch {
    use super::*;

    // ============================================================
    // TXN 1: Initialize launch state + vaults + SOL PDAs + mint supply
    // (NO metadata CPI here; keep that in TXN 2)
    // ============================================================
    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        // basic guards
        require!(params.total_supply > 0, AapedError::InvalidAmount);
        require!(params.sale_supply > 0, AapedError::InvalidAmount);
        require!(params.lp_supply > 0, AapedError::InvalidAmount);

        // exact split
        let sum = params
            .sale_supply
            .checked_add(params.lp_supply)
            .ok_or(AapedError::MathOverflow)?;
        require!(sum == params.total_supply, AapedError::InvalidAmount);

        // metadata length guards (stored on-chain in params)
        require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
        require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
        require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

        let mint_key = ctx.accounts.mint.key();

        // --- create SOL vault PDAs (system-owned accounts) ---
        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.treasury_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[
                b"treasury_sol",
                mint_key.as_ref(),
                &[ctx.bumps.treasury_sol_vault],
            ],
        )?;

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.creator_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[
                b"creator_sol",
                mint_key.as_ref(),
                &[ctx.bumps.creator_sol_vault],
            ],
        )?;

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.platform_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[
                b"platform_sol",
                mint_key.as_ref(),
                &[ctx.bumps.platform_sol_vault],
            ],
        )?;

        // --- derive metadata PDA and store it (do not create here) ---
        let (metadata_pda, _) = Pubkey::find_program_address(
            &[
                b"metadata",
                mpl_token_metadata::ID.as_ref(),
                mint_key.as_ref(),
            ],
            &mpl_token_metadata::ID,
        );

        // --- write state ---
        {
            let st = &mut ctx.accounts.launch_state;

            st.bump = ctx.bumps.launch_state;
            st.treasury_sol_bump = ctx.bumps.treasury_sol_vault;
            st.creator_sol_bump = ctx.bumps.creator_sol_vault;
            st.platform_sol_bump = ctx.bumps.platform_sol_vault;

            st.state = LaunchPhase::Curve as u8;

            st.mint = mint_key;
            st.creator = params.creator;

            // Hardcode platform (ignores params.platform)
            st.platform = PLATFORM_WALLET;

            // Pattern A: lock migration destination
            st.core_authority = params.core_authority;

            st.total_supply = params.total_supply;
            st.sale_supply = params.sale_supply;
            st.lp_supply = params.lp_supply;

            st.v_sol = params.v_sol;
            st.v_tok = params.v_tok;

            st.migration_sol_target = params.migration_sol_target;

            st.fee_total_bps = params.fee_total_bps;
            st.fee_creator_bps = params.fee_creator_bps;
            st.fee_platform_bps = params.fee_platform_bps;
            st.fee_lp_growth_bps = params.fee_lp_growth_bps;

            st.tokens_sold = 0;
            st.sol_collected = 0;
            st.lp_growth_sol = 0;

            st.sale_vault = ctx.accounts.sale_vault.key();
            st.lp_vault = ctx.accounts.lp_vault.key();

            st.treasury_sol_vault = ctx.accounts.treasury_sol_vault.key();
            st.creator_sol_vault = ctx.accounts.creator_sol_vault.key();
            st.platform_sol_vault = ctx.accounts.platform_sol_vault.key();

            st.metadata = metadata_pda;
        }

        // --- mint supply directly into vaults ---
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.sale_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            params.sale_supply,
        )?;

        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.lp_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
            ),
            params.lp_supply,
        )?;

        // --- make mint immutable ---
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
        {
            let st = &mut ctx.accounts.launch_state;
            st.launch_ts = now;
            st.last_trade_ts = now;
        }

        Ok(())
    }

    // ============================================================
    // TXN 2: Create metadata (Metaplex CPI) - IMMUTABLE
    // ============================================================
    pub fn initialize_metadata(ctx: Context<InitializeMetadata>, params: MetadataParams) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        // sanity: metadata account passed must match PDA stored in state
        require_keys_eq!(st.metadata, ctx.accounts.metadata.key(), AapedError::InvalidVault);

        // launch_state PDA signs as update authority in the ix (even though is_mutable=false)
        let signer_seeds: &[&[u8]] = &[b"launch_state", st.mint.as_ref(), &[st.bump]];

        use mpl_token_metadata::instructions::{
            CreateMetadataAccountV3,
            CreateMetadataAccountV3InstructionArgs,
        };
        use mpl_token_metadata::types::DataV2;

        // enforce your limits again (defensive)
        require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
        require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
        require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

        let data = DataV2 {
            name: params.name,
            symbol: params.symbol,
            uri: params.uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        };

        let accounts = CreateMetadataAccountV3 {
            metadata: ctx.accounts.metadata.key(),
            mint: st.mint,
            mint_authority: ctx.accounts.mint_authority.key(),
            payer: ctx.accounts.payer.key(),
            update_authority: (ctx.accounts.launch_state.key(), true),
            system_program: system_program::ID,
            rent: Some(sysvar::rent::ID),
        };

        let args = CreateMetadataAccountV3InstructionArgs {
            data,
            is_mutable: false, // 🔒 immutable
            collection_details: None,
        };

        let ix = accounts.instruction(args);

        invoke_signed(
            &ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.launch_state.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        Ok(())
    }

    // -----------------------------
    // buy (CURVE ONLY) - SOLD OUT DRIVEN migration
    // -----------------------------
    pub fn buy(ctx: Context<Buy>, sol_in: u64) -> Result<()> {
        require!(sol_in > 0, AapedError::InvalidAmount);

        // vault safety (compare passed accounts vs stored)
        {
            let st_ro = &ctx.accounts.launch_state;
            require_keys_eq!(ctx.accounts.sale_vault.key(), st_ro.sale_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.treasury_sol_vault.key(), st_ro.treasury_sol_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.creator_sol_vault.key(), st_ro.creator_sol_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.platform_sol_vault.key(), st_ro.platform_sol_vault, AapedError::InvalidVault);
        }

        let launch_ai = ctx.accounts.launch_state.to_account_info();
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        let st = &mut ctx.accounts.launch_state;
        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        let sale_remaining: u128 = ctx.accounts.sale_vault.amount as u128;
        require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);

        let sol_in_u128: u128 = sol_in as u128;

        // fees config
        let base_fee_bps: u128 = st.fee_total_bps as u128;
        let plat_bps: u128 = st.fee_platform_bps as u128;
        let lp_bps: u128 = st.fee_lp_growth_bps as u128;

        // max net after base fee
        let base_fee_max = bps_amount(sol_in_u128, base_fee_bps)?;
        let sol_eff_max = sol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(AapedError::MathOverflow)?;

        // curve math: note we pass fee_bps=0 because we do fee splitting outside
        let (tokens_out_raw, _, _) = curve_buy(
            sol_eff_max,
            st.sol_collected as u128,
            sale_remaining,
            0,
        )?;
        require!(tokens_out_raw > 0, AapedError::ZeroOutput);

        // cap by remaining inventory (partial fill)
        let tokens_out: u128;
        let sol_eff_used: u128;

        if tokens_out_raw <= sale_remaining {
            tokens_out = tokens_out_raw;
            sol_eff_used = sol_eff_max;
        } else {
            tokens_out = sale_remaining;
            sol_eff_used = curve_sol_eff_for_exact_tokens_cp(tokens_out, st.sol_collected as u128, 0)?;
        }

        // convert used net -> used gross
        let sol_in_used = gross_from_net(sol_eff_used, base_fee_bps)?;
        require!(sol_in_used <= sol_in_u128, AapedError::MathOverflow);

        let base_fee_used = sol_in_used
            .checked_sub(sol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        let platform_fee = bps_amount(sol_in_used, plat_bps)?;
        require!(platform_fee <= base_fee_used, AapedError::MathOverflow);

        let creator_fee = base_fee_used
            .checked_sub(platform_fee)
            .ok_or(AapedError::MathOverflow)?;

        let lp_fee = bps_amount(sol_in_used, lp_bps)?;
        st.lp_growth_sol = st.lp_growth_sol
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        // treasury gets net + lp bucket
        let treasury_amount = sol_eff_used
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        // transfers (only charge USED amounts)
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

        // token out
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
            tokens_out as u64,
        )?;

        // accounting
        st.tokens_sold = st.tokens_sold
            .checked_add(tokens_out as u64)
            .ok_or(AapedError::MathOverflow)?;

        // sol_collected = curve progression (net used)
        st.sol_collected = st.sol_collected
            .checked_add(sol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        // SOLD OUT DRIVEN migration boundary:
        if ctx.accounts.sale_vault.amount == 0 {
            st.state = LaunchPhase::MigrationPending as u8;
        }

        Ok(())
    }

    // -----------------------------
    // sell (CURVE ONLY)
    // -----------------------------
    pub fn sell(ctx: Context<Sell>, tokens_in: u64) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        {
            let st_ro = &ctx.accounts.launch_state;
            require_keys_eq!(ctx.accounts.sale_vault.key(), st_ro.sale_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.treasury_sol_vault.key(), st_ro.treasury_sol_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.creator_sol_vault.key(), st_ro.creator_sol_vault, AapedError::InvalidVault);
            require_keys_eq!(ctx.accounts.platform_sol_vault.key(), st_ro.platform_sol_vault, AapedError::InvalidVault);
        }

        let mint = ctx.accounts.launch_state.mint;
        let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;
        let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

        let st = &mut ctx.accounts.launch_state;
        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        require!(ctx.accounts.seller_ata.amount >= tokens_in, AapedError::InsufficientSaleLiquidity);

        // effective reserve excludes lp bucket
        let treasury_lamports: u128 = ctx.accounts.treasury_sol_vault.lamports() as u128;
        let lp_bucket: u128 = st.lp_growth_sol;

        let sol_real: u128 = treasury_lamports
            .checked_sub(lp_bucket)
            .ok_or(AapedError::MathOverflow)?;

        let tok_real: u128 = ctx.accounts.sale_vault.amount as u128;

        let sol_gross: u128 = curve_sell_gross(tokens_in as u128, sol_real, tok_real)?;
        require!(sol_gross > 0, AapedError::ZeroOutput);
        require!(sol_real >= sol_gross, AapedError::InsufficientTreasuryLiquidity);

        // fees on gross
        let base_fee: u128 = bps_amount(sol_gross, st.fee_total_bps as u128)?;
        let lp_fee: u128 = bps_amount(sol_gross, st.fee_lp_growth_bps as u128)?;
        let platform_fee: u128 = bps_amount(sol_gross, st.fee_platform_bps as u128)?;

        let creator_fee: u128 = base_fee
            .checked_sub(platform_fee)
            .ok_or(AapedError::MathOverflow)?;

        let sol_net: u128 = sol_gross
            .checked_sub(base_fee)
            .ok_or(AapedError::MathOverflow)?
            .checked_sub(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        // tokens back
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

        // seller payout
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

        // fee vaults
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

        // accounting
        st.tokens_sold = st.tokens_sold
            .checked_sub(tokens_in)
            .ok_or(AapedError::MathOverflow)?;

        // If you keep sol_collected as curve progression, reduce by gross (your earlier approach)
        st.sol_collected = st.sol_collected
            .checked_sub(sol_gross)
            .ok_or(AapedError::MathOverflow)?;

        st.lp_growth_sol = st.lp_growth_sol
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        Ok(())
    }

    // -----------------------------
    // claim fees: sweep creator/platform vaults to receivers
    // -----------------------------
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(ctx.accounts.creator_sol_vault.key(), st.creator_sol_vault, AapedError::InvalidVault);
        require_keys_eq!(ctx.accounts.platform_sol_vault.key(), st.platform_sol_vault, AapedError::InvalidVault);

        require_keys_eq!(ctx.accounts.creator_receiver.key(), st.creator, AapedError::InvalidFeeReceiver);
        require_keys_eq!(ctx.accounts.platform_receiver.key(), st.platform, AapedError::InvalidFeeReceiver);

        let mint = st.mint;

        // sweep creator vault
        let creator_lamports = ctx.accounts.creator_sol_vault.to_account_info().lamports();
        if creator_lamports > 0 {
            let bump = st.creator_sol_bump;
            let seeds: &[&[u8]] = &[b"creator_sol", mint.as_ref(), &[bump]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.creator_sol_vault.to_account_info(),
                        to: ctx.accounts.creator_receiver.to_account_info(),
                    },
                    &[seeds],
                ),
                creator_lamports,
            )?;
        }

        // sweep platform vault
        let platform_lamports = ctx.accounts.platform_sol_vault.to_account_info().lamports();
        if platform_lamports > 0 {
            let bump = st.platform_sol_bump;
            let seeds: &[&[u8]] = &[b"platform_sol", mint.as_ref(), &[bump]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.platform_sol_vault.to_account_info(),
                        to: ctx.accounts.platform_receiver.to_account_info(),
                    },
                    &[seeds],
                ),
                platform_lamports,
            )?;
        }

        Ok(())
    }

    // ============================================================
    // Pattern A migration: program moves LP assets to core
    // SOLD OUT DRIVEN: only allowed once state==MigrationPending
    // ============================================================
    pub fn migrate_to_core(ctx: Context<MigrateToCore>) -> Result<()> {
        // read-only first
        let state_now = ctx.accounts.launch_state.state;
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;

        let core_expected = ctx.accounts.launch_state.core_authority;
        let lp_expected = ctx.accounts.launch_state.lp_vault;
        let treasury_expected = ctx.accounts.launch_state.treasury_sol_vault;

        require!(state_now == LaunchPhase::MigrationPending as u8, AapedError::InvalidState);

        require_keys_eq!(ctx.accounts.core_authority.key(), core_expected, AapedError::Unauthorized);
        require_keys_eq!(ctx.accounts.lp_vault.key(), lp_expected, AapedError::InvalidVault);
        require_keys_eq!(ctx.accounts.treasury_sol_vault.key(), treasury_expected, AapedError::InvalidVault);

        // signer seeds for launch_state PDA (token authority)
        let launch_ai = ctx.accounts.launch_state.to_account_info();
        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        // 1) move ALL LP tokens to core LP ATA
        let lp_amount: u64 = ctx.accounts.lp_vault.amount;
        if lp_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.lp_vault.to_account_info(),
                        to: ctx.accounts.core_lp_ata.to_account_info(),
                        authority: launch_ai,
                    },
                    &[signer_seeds],
                ),
                lp_amount,
            )?;
        }

        // 2) move treasury SOL to core SOL vault (leave rent min)
        let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];
        let treasury_lamports: u64 = ctx.accounts.treasury_sol_vault.lamports();
        let rent_min: u64 = Rent::get()?.minimum_balance(0);
        let transferable: u64 = treasury_lamports.saturating_sub(rent_min);

        if transferable > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.treasury_sol_vault.to_account_info(),
                        to: ctx.accounts.core_sol_vault.to_account_info(),
                    },
                    &[treasury_seeds],
                ),
                transferable,
            )?;
        }

        // 3) mark migrated
        let st = &mut ctx.accounts.launch_state;
        st.state = LaunchPhase::Migrated as u8;

        Ok(())
    }
}

// -----------------------------
// helper: create system-owned PDA account (0 space, rent exempt)
// -----------------------------
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

// -----------------------------
// accounts
// -----------------------------

#[derive(Accounts)]
pub struct InitializeMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Who holds mint authority at the time you call initialize_metadata
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: Metaplex metadata PDA (derived off metaplex program)
    #[account(
        mut,
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = mpl_token_metadata::ID
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex program id
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: PDA system account used as fee vault; verified vs launch_state
    #[account(mut)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK: PDA system account used as fee vault; verified vs launch_state
    #[account(mut)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    /// CHECK: must match launch_state.creator
    #[account(mut)]
    pub creator_receiver: UncheckedAccount<'info>,

    /// CHECK: must match launch_state.platform
    #[account(mut)]
    pub platform_receiver: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

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

    /// CHECK
    #[account(mut, seeds = [b"treasury_sol", mint.key().as_ref()], bump)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, seeds = [b"creator_sol", mint.key().as_ref()], bump)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
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

    /// CHECK
    #[account(mut)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
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

    /// CHECK
    #[account(mut)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateToCore<'info> {
    pub core_authority: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub core_lp_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub core_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// used by initialize_metadata
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MetadataParams {
    pub name: String,
    pub symbol: String,
    pub uri: String,
        }
