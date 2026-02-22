use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, sysvar};
use anchor_lang::system_program;

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

/// For now: mint authority wallet is the platform wallet (per your decision)
/// (Later you can rename this wallet in explorers to "AAPED Mint Authority")
pub const MINT_AUTHORITY_WALLET: Pubkey = PLATFORM_WALLET;

// -------------------- EVENTS (Indexer-friendly) --------------------

#[event]
pub struct LaunchInitialized {
    pub mint: Pubkey,
    pub launch_state: Pubkey,
    pub metadata: Pubkey,
    pub payer: Pubkey,
    pub creator: Pubkey,
    pub platform: Pubkey,
    pub core_authority: Pubkey,
    pub total_supply: u64,
    pub sale_supply: u64,
    pub lp_supply: u64,
    pub ts: i64,
}

#[event]
pub struct MetadataInitialized {
    pub mint: Pubkey,
    pub metadata: Pubkey,
    pub payer: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub creators_none: bool,
    pub update_authority_none: bool,
    pub is_mutable: bool,
    pub ts: i64,
}

#[event]
pub struct AuthoritiesFinalized {
    pub mint: Pubkey,
    pub signer: Pubkey,
    pub ts: i64,
}

#[event]
pub struct BuyExecuted {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub sol_in_gross: u64,
    pub sol_eff_used: u64,
    pub tokens_out: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub sol_collected_total: u128,
    pub phase: u8,
    pub ts: i64,
}

#[event]
pub struct SellExecuted {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub tokens_in: u64,
    pub sol_gross: u64,
    pub sol_net: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub sol_collected_total: u128,
    pub phase: u8,
    pub ts: i64,
}

#[event]
pub struct MigrationPending {
    pub mint: Pubkey,
    pub launch_state: Pubkey,
    pub ts: i64,
}

#[event]
pub struct MigratedToCore {
    pub mint: Pubkey,
    pub launch_state: Pubkey,
    pub core_authority: Pubkey,
    pub ts: i64,
}

/// ✅ New: escrow deposit event (optional indexer convenience)
#[event]
pub struct EscrowDeposited {
    pub mint: Pubkey,
    pub depositor: Pubkey,
    pub escrow: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

/// ✅ New: curve activation event (dev buy starts curve)
#[event]
pub struct CurveActivated {
    pub mint: Pubkey,
    pub launch_state: Pubkey,
    pub dev: Pubkey,
    pub sol_in_gross: u64,
    pub tokens_out: u64,
    pub ts: i64,
}

#[program]
pub mod aaped_launch {
    use super::*;

    // ============================================================
    // TXN 1: Initialize launch state + vaults + SOL PDAs + mint supply
    // NOTE: DO NOT revoke mint/freeze authority here (must happen after metadata)
    // NOTE: Curve is NOT live yet. Dev-buy will flip state to Curve.
    // ============================================================
    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        // ---- validate hardcoded platform to avoid silent mismatch ----
        require_keys_eq!(params.platform, PLATFORM_WALLET, AapedError::PlatformMismatch);

        // ---- enforce mint authority signer is the chosen "mint authority wallet" ----
        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            MINT_AUTHORITY_WALLET,
            AapedError::Unauthorized
        );

        // ---- ensure the mint is actually controlled by this mint authority at this time ----
        let mint_auth = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(AapedError::Unauthorized)?;
        require_keys_eq!(mint_auth, ctx.accounts.mint_authority.key(), AapedError::Unauthorized);

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

        // ✅ New: escrow PDA (system-owned, holds dev-buy SOL)
        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.escrow_sol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            0,
            &[
                b"escrow_sol",
                mint_key.as_ref(),
                &[ctx.bumps.escrow_sol_vault],
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

            // ✅ New bump storage (requires matching fields in LaunchState)
            st.escrow_sol_bump = ctx.bumps.escrow_sol_vault;

            // ✅ Fail-safe: curve NOT live until dev-buy instruction runs
            // Requires LaunchPhase::PendingDevBuy in your state enum.
            st.state = LaunchPhase::PendingDevBuy as u8;

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

            // ✅ New: escrow vault pointer (requires matching field in LaunchState)
            st.escrow_sol_vault = ctx.accounts.escrow_sol_vault.key();

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

        // ---- Emit indexer event (Pump-like "CreateEvent" equivalent) ----
        emit!(LaunchInitialized {
            mint: mint_key,
            launch_state: ctx.accounts.launch_state.key(),
            metadata: ctx.accounts.launch_state.metadata,
            payer: ctx.accounts.payer.key(),
            creator: params.creator,
            platform: PLATFORM_WALLET,
            core_authority: params.core_authority,
            total_supply: params.total_supply,
            sale_supply: params.sale_supply,
            lp_supply: params.lp_supply,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ============================================================
    // TXN 2: Create metadata (Metaplex CPI) - IMMUTABLE
    // ============================================================
    
                pub fn initialize_metadata(
    ctx: Context<InitializeMetadata>,
    metadata_bump: u8,
    params: MetadataParams,
) -> Result<()> {
    let st = &ctx.accounts.launch_state;

    // lock mint + metadata to state
    require_keys_eq!(st.mint, ctx.accounts.mint.key(), AapedError::InvalidVault);
    require_keys_eq!(st.metadata, ctx.accounts.metadata.key(), AapedError::InvalidVault);

    // mint authority must match your chosen authority wallet
    require_keys_eq!(
        ctx.accounts.mint_authority.key(),
        MINT_AUTHORITY_WALLET,
        AapedError::Unauthorized
    );

    // mint must still be controlled by this authority
    let mint_auth = ctx
        .accounts
        .mint
        .mint_authority
        .ok_or(AapedError::Unauthorized)?;
    require_keys_eq!(mint_auth, ctx.accounts.mint_authority.key(), AapedError::Unauthorized);

    require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
    require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
    require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

    use mpl_token_metadata::instructions::{
        CreateMetadataAccountV3,
        CreateMetadataAccountV3InstructionArgs,
    };
    use mpl_token_metadata::types::DataV2;

    let data = DataV2 {
        name: params.name.clone(),
        symbol: params.symbol.clone(),
        uri: params.uri.clone(),
        seller_fee_basis_points: 0,
        creators: None, // Pump style
        collection: None,
        uses: None,
    };

    let create_ix = CreateMetadataAccountV3 {
        metadata: ctx.accounts.metadata.key(),
        mint: st.mint,
        mint_authority: (ctx.accounts.mint_authority.key(), true),
        payer: ctx.accounts.payer.key(),
        update_authority: (ctx.accounts.mint_authority.key(), true),
        system_program: system_program::ID,
        rent: Some(sysvar::rent::ID),
    }
    .instruction(CreateMetadataAccountV3InstructionArgs {
        data,
        is_mutable: false,
        collection_details: None,
    });

    invoke(
        &create_ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.mint_authority.to_account_info(),
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
    )?;

    emit!(MetadataInitialized {
        mint: st.mint,
        metadata: ctx.accounts.metadata.key(),
        payer: ctx.accounts.payer.key(),
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
        creators_none: true,
        update_authority_none: false,
        is_mutable: false,
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
  }

    // ============================================================
    // TXN 3: Revoke Mint + Freeze authority (after metadata exists)
    // ============================================================
    pub fn finalize_mint_authorities(
    ctx: Context<FinalizeMintAuthorities>,
    metadata_bump: u8,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.launch_state.metadata,
        ctx.accounts.metadata.key(),
        AapedError::InvalidVault
    );

    require_keys_eq!(
        ctx.accounts.mint_authority.key(),
        MINT_AUTHORITY_WALLET,
        AapedError::Unauthorized
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

    emit!(AuthoritiesFinalized {
        mint: ctx.accounts.mint.key(),
        signer: ctx.accounts.mint_authority.key(),
        ts: Clock::get()?.unix_timestamp,
    });

    Ok(())
    }
    
    pub fn deposit_escrow(ctx: Context<DepositEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, AapedError::InvalidAmount);

        let st = &ctx.accounts.launch_state;
        require_keys_eq!(ctx.accounts.escrow_sol_vault.key(), st.escrow_sol_vault, AapedError::InvalidVault);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.escrow_sol_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(EscrowDeposited {
            mint: st.mint,
            depositor: ctx.accounts.depositor.key(),
            escrow: ctx.accounts.escrow_sol_vault.key(),
            amount,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ============================================================
    // ✅ New: mandatory dev buy that flips state -> Curve (live)
    // Uses escrow PDA as SOL source. This is your fail-safe gate.
    // ============================================================
    pub fn dev_buy_start_curve(ctx: Context<DevBuyStartCurve>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, AapedError::InvalidAmount);

        // ✅ FIX #2 (E0502 style issues): cache keys BEFORE taking &mut
        let launch_state_key = ctx.accounts.launch_state.key();
        let mint = ctx.accounts.launch_state.mint;

        let st = &mut ctx.accounts.launch_state;

        // must be pending dev buy
        require!(st.state == LaunchPhase::PendingDevBuy as u8, AapedError::InvalidState);

        // escrow must match state
        require_keys_eq!(ctx.accounts.escrow_sol_vault.key(), st.escrow_sol_vault, AapedError::InvalidVault);

        // dev ATA must be for this mint (basic safety)
        require_keys_eq!(ctx.accounts.dev_ata.mint, mint, AapedError::InvalidVault);

        // escrow seeds
        let escrow_bump = st.escrow_sol_bump;
        let escrow_seeds: &[&[u8]] = &[b"escrow_sol", mint.as_ref(), &[escrow_bump]];

        // launch_state signer seeds for token transfer from sale_vault
        let bump = st.bump;
        let launch_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        // check sale liquidity
        let sale_remaining: u128 = ctx.accounts.sale_vault.amount as u128;
        require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);
        require!((min_tokens_out as u128) <= sale_remaining, AapedError::InsufficientSaleLiquidity);

        // escrow balance must cover sol_in
        let escrow_lamports: u64 = ctx.accounts.escrow_sol_vault.lamports();
        require!(escrow_lamports >= sol_in, AapedError::InsufficientTreasuryLiquidity);

        // pricing math (same as buy, but SOL source is escrow)
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

        // ---- move SOL out of escrow PDA to vault buckets (invoke_signed) ----
        // creator fee
        if creator_fee > 0 {
            let ix = system_program::transfer(
                &system_program::ID,
                &ctx.accounts.escrow_sol_vault.key(),
                &ctx.accounts.creator_sol_vault.key(),
                creator_fee as u64,
            );
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.escrow_sol_vault.to_account_info(),
                    ctx.accounts.creator_sol_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[escrow_seeds],
            )?;
        }

        // platform fee
        if platform_fee > 0 {
            let ix = system_program::transfer(
                &system_program::ID,
                &ctx.accounts.escrow_sol_vault.key(),
                &ctx.accounts.platform_sol_vault.key(),
                platform_fee as u64,
            );
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.escrow_sol_vault.to_account_info(),
                    ctx.accounts.platform_sol_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[escrow_seeds],
            )?;
        }

        // treasury (effective + lp)
        if treasury_amount > 0 {
            let ix = system_program::transfer(
                &system_program::ID,
                &ctx.accounts.escrow_sol_vault.key(),
                &ctx.accounts.treasury_sol_vault.key(),
                treasury_amount as u64,
            );
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.escrow_sol_vault.to_account_info(),
                    ctx.accounts.treasury_sol_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[escrow_seeds],
            )?;
        }

        // ---- deliver tokens to dev ----
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.dev_ata.to_account_info(),
                    authority: launch_ai,
                },
                &[launch_seeds],
            ),
            tokens_out as u64,
        )?;

        ctx.accounts.sale_vault.reload()?;

        // accounting updates
        st.tokens_sold = st.tokens_sold
            .checked_add(tokens_out as u64)
            .ok_or(AapedError::MathOverflow)?;

        st.sol_collected = st.sol_collected
            .checked_add(sol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

        // ✅ flip curve live NOW
        st.state = LaunchPhase::Curve as u8;

        emit!(CurveActivated {
            mint,
            launch_state: launch_state_key,
            dev: ctx.accounts.dev.key(),
            sol_in_gross: sol_in_used as u64,
            tokens_out: tokens_out as u64,
            ts: Clock::get()?.unix_timestamp,
        });

        // Also emit BuyExecuted so your indexer sees a unified trade stream
        emit!(BuyExecuted {
            mint,
            user: ctx.accounts.dev.key(),
            sol_in_gross: sol_in_used as u64,
            sol_eff_used: sol_eff_used as u64,
            tokens_out: tokens_out as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: lp_fee as u64,
            tokens_sold_total: st.tokens_sold,
            sol_collected_total: st.sol_collected,
            phase: st.state,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // -----------------------------
    // BUY (CURVE ONLY)  ✅ gated by Curve state
    // -----------------------------
    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, AapedError::InvalidAmount);

        // ✅ FIX #2: cache keys before &mut borrow
        let launch_state_key = ctx.accounts.launch_state.key();

        let launch_ai = ctx.accounts.launch_state.to_account_info();
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        let st = &mut ctx.accounts.launch_state;

        // ✅ Fail-safe gate: curve must be live
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

        ctx.accounts.sale_vault.reload()?;

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

            emit!(MigrationPending {
                mint,
                launch_state: launch_state_key,
                ts: Clock::get()?.unix_timestamp,
            });
        }

        emit!(BuyExecuted {
            mint,
            user: ctx.accounts.buyer.key(),
            sol_in_gross: sol_in_used as u64,
            sol_eff_used: sol_eff_used as u64,
            tokens_out: tokens_out as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: lp_fee as u64,
            tokens_sold_total: st.tokens_sold,
            sol_collected_total: st.sol_collected,
            phase: st.state,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // -----------------------------
    // SELL (CURVE ONLY)  ✅ gated by Curve state
    // -----------------------------
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;
        let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

        let st = &mut ctx.accounts.launch_state;

        // ✅ Fail-safe gate: curve must be live
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

        emit!(SellExecuted {
            mint,
            user: ctx.accounts.seller.key(),
            tokens_in,
            sol_gross: sol_gross as u64,
            sol_net: sol_net as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: lp_fee as u64,
            tokens_sold_total: st.tokens_sold,
            sol_collected_total: st.sol_collected,
            phase: st.state,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // -----------------------------
    // claim fees: sweep creator/platform vaults to receivers
    // Leaves rent-minimum in vault PDAs
    // -----------------------------
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(
            ctx.accounts.creator_receiver.key(),
            st.creator,
            AapedError::InvalidFeeReceiver
        );
        require_keys_eq!(
            ctx.accounts.platform_receiver.key(),
            st.platform,
            AapedError::InvalidFeeReceiver
        );

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

        emit!(MigratedToCore {
            mint,
            launch_state: ctx.accounts.launch_state.key(),
            core_authority: ctx.accounts.core_authority.key(),
            ts: Clock::get()?.unix_timestamp,
        });

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

    /// Mint authority wallet (for now: PLATFORM_WALLET)
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

    /// ✅ New: escrow PDA (system-owned)
    /// CHECK
    #[account(mut, seeds = [b"escrow_sol", mint.key().as_ref()], bump)]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(metadata_bump: u8, params: MetadataParams)]
pub struct InitializeMetadata<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Mint authority wallet
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
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.key().as_ref()
        ],
        bump = metadata_bump,
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
#[instruction(metadata_bump: u8)]
pub struct FinalizeMintAuthorities<'info> {
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK
    #[account(
        mut,
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.key().as_ref()
        ],
        bump = metadata_bump,
        seeds::program = mpl_token_metadata::ID
    )]
    pub metadata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositEscrow<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK
    #[account(mut, seeds = [b"escrow_sol", mint.key().as_ref()], bump = launch_state.escrow_sol_bump)]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DevBuyStartCurve<'info> {
    #[account(mut)]
    pub dev: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.sale_vault)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub dev_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.platform_sol_vault)]
    pub platform_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.escrow_sol_vault)]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
