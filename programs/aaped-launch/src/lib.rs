use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_lang::solana_program::sysvar;

pub mod errors;
pub mod math;
pub mod state;

use crate::errors::AapedError;
use crate::math::*;
use crate::state::*;

use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;

// Metaplex (mpl-token-metadata)
use mpl_token_metadata;

declare_id!("DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk");

// -------------------- CONSTANTS --------------------
use anchor_lang::prelude::pubkey;

/// Hardcoded platform wallet (validated at init to avoid silent mismatches)
pub const PLATFORM_WALLET: Pubkey =
    pubkey!("BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL");

#[program]
pub mod aaped_launch {
    use super::*;

    // ============================================================
    // TXN 1: Initialize launch state + vaults + SOL PDAs + mint supply
    // NOTE: DO NOT revoke mint/freeze authority here (must happen after metadata)
    // ============================================================
    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        // ---- validate hardcoded platform to avoid silent mismatch ----
        require_keys_eq!(params.platform, PLATFORM_WALLET, AapedError::PlatformMismatch);

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

        // metadata input guards (even though metadata is TX2)
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

            // hardcode platform (validated above)
            st.platform = PLATFORM_WALLET;

            // Pattern A: lock migration destination
            st.core_authority = params.core_authority;

            // supply
            st.total_supply = params.total_supply;
            st.sale_supply = params.sale_supply;
            st.lp_supply = params.lp_supply;

            // curve
            st.v_sol = params.v_sol;
            st.v_tok = params.v_tok;

            // migration
            st.migration_sol_target = params.migration_sol_target;

            // fees
            st.fee_total_bps = params.fee_total_bps;
            st.fee_creator_bps = params.fee_creator_bps;
            st.fee_platform_bps = params.fee_platform_bps;
            st.fee_lp_growth_bps = params.fee_lp_growth_bps;

            // accounting
            st.tokens_sold = 0;
            st.sol_collected = 0;
            st.lp_growth_sol = 0;

            // vaults
            st.sale_vault = ctx.accounts.sale_vault.key();
            st.lp_vault = ctx.accounts.lp_vault.key();

            st.treasury_sol_vault = ctx.accounts.treasury_sol_vault.key();
            st.creator_sol_vault = ctx.accounts.creator_sol_vault.key();
            st.platform_sol_vault = ctx.accounts.platform_sol_vault.key();

            // metadata pointer
            st.metadata = metadata_pda;

            let now = Clock::get()?.unix_timestamp;
            st.launch_ts = now;
            st.last_trade_ts = now;
        }

        // --- mint supply directly into vaults (mint authority still active here) ---
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

        Ok(())
    }

    // ============================================================
    // TXN 2: Create metadata (Metaplex CPI) - IMMUTABLE
    // ============================================================
    pub fn initialize_metadata(
    ctx: Context<InitializeMetadata>,
    params: MetadataParams,
) -> Result<()> {
    let st = &ctx.accounts.launch_state;

    // must match PDA you stored in state
    require_keys_eq!(st.metadata, ctx.accounts.metadata.key(), AapedError::InvalidVault);

    // input guards
    require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
    require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
    require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

    // launch_state PDA signs (update authority actions)
    let signer_seeds: &[&[u8]] = &[b"launch_state", st.mint.as_ref(), &[st.bump]];

    use mpl_token_metadata::instructions::{
        CreateMetadataAccountV3, CreateMetadataAccountV3InstructionArgs,
        UpdateMetadataAccountV2, UpdateMetadataAccountV2InstructionArgs,
    };
    use mpl_token_metadata::types::{Creator, DataV2};

    // Creator = payer (signer of this tx)
    // This makes Solscan show "Creator".
    let creators = Some(vec![Creator {
        address: ctx.accounts.payer.key(),
        verified: false, // keep false unless you also run a verify instruction
        share: 100,
    }]);

    let data = DataV2 {
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
        seller_fee_basis_points: 0,
        creators,
        collection: None,
        uses: None,
    };

    // -------------------------
    // 1) CREATE METADATA
    // -------------------------
    let create_accounts = CreateMetadataAccountV3 {
        metadata: ctx.accounts.metadata.key(),
        mint: st.mint,
        mint_authority: ctx.accounts.mint_authority.key(),
        payer: ctx.accounts.payer.key(),

        // Temporary update authority = launch_state PDA (must sign via invoke_signed)
        update_authority: (ctx.accounts.launch_state.key(), true),

        system_program: system_program::ID,
        rent: Some(sysvar::rent::ID),
    };

    let create_args = CreateMetadataAccountV3InstructionArgs {
        data,
        is_mutable: false,
        collection_details: None,
    };

    let create_ix = create_accounts.instruction(create_args);

    invoke_signed(
        &create_ix,
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

    // -------------------------
    // 2) RENOUNCE UPDATE AUTHORITY (so explorers show N/A)
    //    IMPORTANT: None = "no change"
    //    Use Some(Pubkey::default()) to effectively burn it.
    // -------------------------
    let renounce_accounts = UpdateMetadataAccountV2 {
        metadata: ctx.accounts.metadata.key(),
        update_authority: ctx.accounts.launch_state.key(),
    };

    let renounce_args = UpdateMetadataAccountV2InstructionArgs {
        data: None,
        new_update_authority: Some(Pubkey::default()), // 11111111111111111111111111111111
        primary_sale_happened: None,
        is_mutable: Some(false),
    };

    let renounce_ix = renounce_accounts.instruction(renounce_args);

    invoke_signed(
        &renounce_ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.launch_state.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    Ok(())
}
    // ============================================================
    // TXN 3: Revoke Mint + Freeze authority (after metadata exists)
    // ============================================================
    pub fn finalize_mint_authorities(ctx: Context<FinalizeMintAuthorities>) -> Result<()> {
        // ensure metadata matches the state pointer
        require_keys_eq!(
            ctx.accounts.launch_state.metadata,
            ctx.accounts.metadata.key(),
            AapedError::InvalidVault
        );

        // revoke mint authority
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

        // revoke freeze authority
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

    // -----------------------------
    // BUY (CURVE ONLY)
    // -----------------------------
    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, AapedError::InvalidAmount);

        let launch_ai = ctx.accounts.launch_state.to_account_info();
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        let st = &mut ctx.accounts.launch_state;
        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        let sale_remaining: u128 = ctx.accounts.sale_vault.amount as u128;
        require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);

        require!(
            (min_tokens_out as u128) <= sale_remaining,
            AapedError::InsufficientSaleLiquidity
        );

        let sol_in_u128: u128 = sol_in as u128;

        let base_fee_bps: u128 = st.fee_total_bps as u128;
        let plat_bps: u128 = st.fee_platform_bps as u128;
        let lp_bps: u128 = st.fee_lp_growth_bps as u128;

        let base_fee_max = bps_amount(sol_in_u128, base_fee_bps)?;
        let sol_eff_max = sol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(AapedError::MathOverflow)?;

        let (tokens_out_raw, _, _) =
            curve_buy(sol_eff_max, st.sol_collected as u128, sale_remaining, 0)?;
        require!(tokens_out_raw > 0, AapedError::ZeroOutput);

        let (tokens_out, sol_eff_used): (u128, u128) = if tokens_out_raw <= sale_remaining {
            (tokens_out_raw, sol_eff_max)
        } else {
            let sol_eff_needed = curve_sol_eff_for_exact_tokens_cp(
                sale_remaining,
                st.sol_collected as u128,
                sale_remaining,
            )?;
            (sale_remaining, sol_eff_needed)
        };

        require!(tokens_out >= min_tokens_out as u128, AapedError::SlippageExceeded);

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

        let treasury_amount = sol_eff_used
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

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

// ✅ refresh the token account data after CPI
ctx.accounts.sale_vault.reload()?;

// accounting updates...
st.tokens_sold = st.tokens_sold
    .checked_add(tokens_out as u64)
    .ok_or(AapedError::MathOverflow)?;

st.sol_collected = st.sol_collected
    .checked_add(sol_eff_used)
    .ok_or(AapedError::MathOverflow)?;

st.last_trade_ts = Clock::get()?.unix_timestamp;

require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

if ctx.accounts.sale_vault.amount == 0 {
    require!(st.tokens_sold == st.sale_supply, AapedError::MathOverflow);
    st.state = LaunchPhase::MigrationPending as u8;
}

        Ok(())
    }

    // -----------------------------
    // SELL (CURVE ONLY)
    // -----------------------------
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;
        let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

        let st = &mut ctx.accounts.launch_state;
        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        require!(
            ctx.accounts.seller_ata.amount >= tokens_in,
            AapedError::InsufficientSaleLiquidity
        );

        let treasury_lamports: u128 = ctx.accounts.treasury_sol_vault.lamports() as u128;
        let lp_bucket: u128 = st.lp_growth_sol;

        let sol_real: u128 = treasury_lamports
            .checked_sub(lp_bucket)
            .ok_or(AapedError::MathOverflow)?;

        let tok_real: u128 = ctx.accounts.sale_vault.amount as u128;

        let sol_gross: u128 = curve_sell_gross(tokens_in as u128, sol_real, tok_real)?;
        require!(sol_gross > 0, AapedError::ZeroOutput);
        require!(sol_real >= sol_gross, AapedError::InsufficientTreasuryLiquidity);

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

        require!(sol_net >= min_sol_out as u128, AapedError::SlippageExceeded);

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

        st.tokens_sold = st.tokens_sold
            .checked_sub(tokens_in)
            .ok_or(AapedError::MathOverflow)?;

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
    // Leaves rent-minimum in vault PDAs
    // -----------------------------
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(ctx.accounts.creator_receiver.key(), st.creator, AapedError::InvalidFeeReceiver);
        require_keys_eq!(ctx.accounts.platform_receiver.key(), st.platform, AapedError::InvalidFeeReceiver);

        let mint = st.mint;

        sweep_pda_to(
            &ctx.accounts.system_program,
            &ctx.accounts.creator_sol_vault,
            &ctx.accounts.creator_receiver,
            &[b"creator_sol", mint.as_ref(), &[st.creator_sol_bump]],
        )?;

        sweep_pda_to(
            &ctx.accounts.system_program,
            &ctx.accounts.platform_sol_vault,
            &ctx.accounts.platform_receiver,
            &[b"platform_sol", mint.as_ref(), &[st.platform_sol_bump]],
        )?;

        Ok(())
    }

    // ============================================================
    // Pattern A migration (unchanged)
    // ============================================================
    pub fn migrate_to_core(ctx: Context<MigrateToCore>) -> Result<()> {
        let state_now = ctx.accounts.launch_state.state;
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;

        require!(state_now == LaunchPhase::MigrationPending as u8, AapedError::InvalidState);

        require_keys_eq!(
            ctx.accounts.core_authority.key(),
            ctx.accounts.launch_state.core_authority,
            AapedError::Unauthorized
        );

        let launch_ai = ctx.accounts.launch_state.to_account_info();
        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

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
// helper: sweep a PDA system account leaving rent min
// -----------------------------
fn sweep_pda_to<'info>(
    system_program: &Program<'info, System>,
    from_pda: &UncheckedAccount<'info>,
    to: &UncheckedAccount<'info>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let from_lamports = from_pda.to_account_info().lamports();
    let rent_min = Rent::get()?.minimum_balance(0);
    let transferable = from_lamports.saturating_sub(rent_min);

    if transferable > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: from_pda.to_account_info(),
                    to: to.to_account_info(),
                },
                &[signer_seeds],
            ),
            transferable,
        )?;
    }

    Ok(())
}

// -----------------------------
// accounts
// -----------------------------
#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Who holds mint authority at init time
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

    /// CHECK: Metaplex metadata PDA
    #[account(
        mut,
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = mpl_token_metadata::ID
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FinalizeMintAuthorities<'info> {
    /// mint authority must still exist at this point (TX3)
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: must match st.metadata
    #[account(
        mut,
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = mpl_token_metadata::ID
    )]
    pub metadata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, has_one = sale_vault)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.sale_vault)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.platform_sol_vault)]
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

    #[account(mut, address = launch_state.sale_vault)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.platform_sol_vault)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.platform_sol_vault)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub creator_receiver: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut)]
    pub platform_receiver: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateToCore<'info> {
    pub core_authority: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub core_lp_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
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
