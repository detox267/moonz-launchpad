use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::{sysvar, system_instruction};
use anchor_lang::system_program;
use solana_security_txt::security_txt;

use anchor_lang::{AccountDeserialize, AccountSerialize};

pub mod errors;
pub mod math;
pub mod state;

use crate::errors::AapedError;
use crate::math::*;
use crate::state::*;

use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use mpl_token_metadata;
use mpl_token_metadata::types::{Creator, DataV2};


declare_id!("DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "AAPED Launchpad",
    project_url: "https://aaped.fun",
    contacts: "Use github",
    source_code: "https://github.com/detox267/aaped-launch",
    preferred_languages: "en",
    source_revision: "main"
}

// -------------------- CONSTANTS --------------------

/// Hardcoded platform wallet (validated at init to avoid silent mismatches)
pub const PLATFORM_WALLET: Pubkey =
    pubkey!("BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL");

/// For now: mint authority wallet is the platform wallet (per your decision)
pub const MINT_AUTHORITY_WALLET: Pubkey = PLATFORM_WALLET;

// -------------------- EVENTS (Indexer-friendly) --------------------
pub const TOTAL_TOKENS: u64 = 1_000_000_000;
pub const SALE_TOKENS:  u64 =   750_000_000;
pub const LP_TOKENS:    u64 =   250_000_000;

fn pow10_u64(decimals: u8) -> Result<u64> {
    require!(decimals <= 18, AapedError::InvalidAmount);
    let mut v: u64 = 1;
    for _ in 0..decimals {
        v = v.checked_mul(10).ok_or(AapedError::MathOverflow)?;
    }
    Ok(v)
}

fn to_base_units(tokens: u64, decimals: u8) -> Result<u64> {
    let scale = pow10_u64(decimals)?;
    let out = tokens
        .checked_mul(scale)
        .ok_or(AapedError::MathOverflow)?;
    Ok(out)
}

// -------------------- MINIMAL EVENTS (Indexer-friendly) --------------------

#[event]
pub struct CreatedTxn {
    pub mint: Pubkey,
    pub devbuy: u64,            // lamports in (gross)
    pub curve_change: u64,      // vsol + devbuy (or whatever you define as "curve change")
    pub ipfs_cid: String,       // CID only (no https://)
}

#[event]
pub struct BuyEvent {
    pub mint: Pubkey,
    pub amount: u64,            // lamports in (gross)
    // signature is not emitted; indexer gets tx signature from logs/tx meta
}

#[event]
pub struct SellEvent {
    pub mint: Pubkey,
    pub amount: u64,            // tokens in
    // signature comes from tx meta
}

#[event]
pub struct ClaimfeesEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,        // creator wallet (receiver)
    pub amount: u64,            // lamports swept
}

#[event]
pub struct AmmBuyEvent {
    pub mint: Pubkey,
    pub amount: u64, // lamports in
}

#[event]
pub struct AmmSellEvent {
    pub mint: Pubkey,
    pub amount: u64, // tokens in
}

#[event]
pub struct MigratedEvent {
    pub mint: Pubkey,
}

#[program]
pub mod aaped_launch {
    use super::*;

    // ============================================================
    // TX0: user funds escrow PDA (and creates it if missing)
    // ============================================================
    pub fn deposit_escrow(ctx: Context<DepositEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, AapedError::InvalidAmount);

        let mint_key = ctx.accounts.mint.key();

        // Create escrow PDA if missing (rent-exempt, 0 space, system-owned)
        create_pda_system_account(
            &ctx.accounts.depositor,
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

        Ok(())
    }
    
    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
    // platform must sign and match hardcoded wallet
    require_keys_eq!(
        ctx.accounts.platform_signer.key(),
        PLATFORM_WALLET,
        AapedError::Unauthorized
    );

    // validate hardcoded platform param to avoid silent mismatch
    require_keys_eq!(params.platform, PLATFORM_WALLET, AapedError::PlatformMismatch);

    // enforce mint authority signer is platform wallet
    require_keys_eq!(
        ctx.accounts.mint_authority.key(),
        MINT_AUTHORITY_WALLET,
        AapedError::Unauthorized
    );

    // ensure mint is controlled by mint_authority at this time
    let mint_auth = ctx
        .accounts
        .mint
        .mint_authority
        .ok_or(AapedError::Unauthorized)?;
    require_keys_eq!(mint_auth, ctx.accounts.mint_authority.key(), AapedError::Unauthorized);

    // metadata input guards (even though metadata is TX2)
    require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
    require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
    require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

    let mint_key = ctx.accounts.mint.key();

    // ============================================================
    // HARD-LOCK SUPPLIES USING MINT DECIMALS
    // ============================================================
    let decimals = ctx.accounts.mint.decimals;

    let total_supply_locked = to_base_units(TOTAL_TOKENS, decimals)?;
    let sale_supply_locked  = to_base_units(SALE_TOKENS,  decimals)?;
    let lp_supply_locked    = to_base_units(LP_TOKENS,    decimals)?;

    // sanity: sale + lp == total
    require!(
        sale_supply_locked
            .checked_add(lp_supply_locked)
            .ok_or(AapedError::MathOverflow)? == total_supply_locked,
        AapedError::MathOverflow
    );

    // keep params hard-locked to your chosen tokenomics
    require!(params.total_supply == total_supply_locked, AapedError::InvalidAmount);
    require!(params.sale_supply  == sale_supply_locked,  AapedError::InvalidAmount);
    require!(params.lp_supply    == lp_supply_locked,    AapedError::InvalidAmount);

    // ============================================================
    // escrow must already exist + be funded (TX0)
    // ============================================================
    require!(
        ctx.accounts.escrow_sol_vault.lamports() >= Rent::get()?.minimum_balance(0),
        AapedError::InsufficientTreasuryLiquidity
    );

    let escrow_bump = ctx.bumps.escrow_sol_vault;
    let escrow_seeds: &[&[u8]] = &[
        b"escrow_sol",
        mint_key.as_ref(),
        &[escrow_bump],
    ];

    // ============================================================
    // Create PDAs
    // ============================================================

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.treasury_sol_vault,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        0,
        &system_program::ID,
        &[
            b"treasury_sol",
            mint_key.as_ref(),
            &[ctx.bumps.treasury_sol_vault],
        ],
        escrow_seeds,
    )?;

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.creator_sol_vault,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        0,
        &system_program::ID,
        &[
            b"creator_sol",
            mint_key.as_ref(),
            &[ctx.bumps.creator_sol_vault],
        ],
        escrow_seeds,
    )?;

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.launch_state,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        LaunchState::LEN,
        &crate::ID,
        &[
            b"launch_state",
            mint_key.as_ref(),
            &[ctx.bumps.launch_state],
        ],
        escrow_seeds,
    )?;

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.sale_vault,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        anchor_spl::token::TokenAccount::LEN,
        &ctx.accounts.token_program.key(),
        &[
            b"sale_vault",
            mint_key.as_ref(),
            &[ctx.bumps.sale_vault],
        ],
        escrow_seeds,
    )?;

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.lp_vault,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        anchor_spl::token::TokenAccount::LEN,
        &ctx.accounts.token_program.key(),
        &[
            b"lp_vault",
            mint_key.as_ref(),
            &[ctx.bumps.lp_vault],
        ],
        escrow_seeds,
    )?;

    {
        let launch_state_key = ctx.accounts.launch_state.key();

        let ix_sale = anchor_spl::token::spl_token::instruction::initialize_account3(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.sale_vault.key(),
            &mint_key,
            &launch_state_key,
        )?;
        invoke(
            &ix_sale,
            &[
                ctx.accounts.sale_vault.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        let ix_lp = anchor_spl::token::spl_token::instruction::initialize_account3(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.lp_vault.key(),
            &mint_key,
            &launch_state_key,
        )?;
        invoke(
            &ix_lp,
            &[
                ctx.accounts.lp_vault.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
    }

    let (metadata_pda, _) = Pubkey::find_program_address(
        &[
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint_key.as_ref(),
        ],
        &mpl_token_metadata::ID,
    );

    // ============================================================
    // Write LaunchState
    // ============================================================
    let launch_ai = ctx.accounts.launch_state.to_account_info();

    let mut st: LaunchState =
        LaunchState::try_deserialize_unchecked(&mut &launch_ai.data.borrow()[..])?;

    st.bump = ctx.bumps.launch_state;
    st.treasury_sol_bump = ctx.bumps.treasury_sol_vault;
    st.creator_sol_bump = ctx.bumps.creator_sol_vault;
    st.escrow_sol_bump = ctx.bumps.escrow_sol_vault;

    st.state = LaunchPhase::PendingDevBuy as u8;

    st.mint = mint_key;
    st.creator = params.creator;
    st.platform = PLATFORM_WALLET;
    st.core_authority = params.core_authority;

    st.total_supply = total_supply_locked;
    st.sale_supply  = sale_supply_locked;
    st.lp_supply    = lp_supply_locked;

    st.amm_initial_sol = 0;
    st.amm_initial_tok = 0;
    st.migrated_at = 0;

    st.fee_total_bps = params.fee_total_bps;
    st.fee_creator_bps = params.fee_creator_bps;
    st.fee_platform_bps = params.fee_platform_bps;

    st.tokens_sold = 0;
    st.sol_collected = 0;

    st.sale_vault = ctx.accounts.sale_vault.key();
    st.lp_vault = ctx.accounts.lp_vault.key();

    st.treasury_sol_vault = ctx.accounts.treasury_sol_vault.key();
    st.creator_sol_vault = ctx.accounts.creator_sol_vault.key();
    st.escrow_sol_vault = ctx.accounts.escrow_sol_vault.key();

    st.metadata = metadata_pda;

    st.dev_buy_done = false;
    st.escrow_settled = false;

    let now = Clock::get()?.unix_timestamp;
    st.launch_ts = now;
    st.last_trade_ts = now;

    let mut data = launch_ai.data.borrow_mut();
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    st.try_serialize(&mut cursor)?;

    // ============================================================
    // Mint supply directly into vaults
    // ============================================================
    token::mint_to(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.sale_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
        ),
        sale_supply_locked,
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
        lp_supply_locked,
    )?;

    Ok(())
        }
    // ============================================================
    // TXN 2: Create metadata (Metaplex CPI) - IMMUTABLE
    // ============================================================
    pub fn initialize_metadata(
        ctx: Context<InitializeMetadata>,
        _metadata_bump: u8,
        params: MetadataParams,
    ) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(st.mint, ctx.accounts.mint.key(), AapedError::InvalidVault);
        require_keys_eq!(st.metadata, ctx.accounts.metadata.key(), AapedError::InvalidVault);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            MINT_AUTHORITY_WALLET,
            AapedError::Unauthorized
        );

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
            creators: Some(vec![
                Creator {
                address: st.creator,
                verified: false,
                share: 100,
             },
         ]),
         collection: None,
         uses: None,
        };

        let create_ix = CreateMetadataAccountV3 {
            metadata: ctx.accounts.metadata.key(),
            mint: st.mint,
            mint_authority: ctx.accounts.mint_authority.key(),
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

        Ok(())
    }

    // ============================================================
    // TXN 3: Revoke Mint + Freeze authority (after metadata exists)
    // ============================================================
    pub fn finalize_mint_authorities(
        ctx: Context<FinalizeMintAuthorities>,
        _metadata_bump: u8,
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

        Ok(())
    }

    pub fn dev_buy_start_curve(
    ctx: Context<DevBuyStartCurve>,
    sol_in: u64,
    min_tokens_out: u64,
    ipfs_cid: String, // CID only (no link)
) -> Result<()> {
    require!(sol_in > 0, AapedError::InvalidAmount);
    require!(ipfs_cid.as_bytes().len() <= 120, AapedError::InvalidAmount);

    let mint = ctx.accounts.launch_state.mint;
    let launch_bump = ctx.accounts.launch_state.bump;
    let escrow_bump = ctx.accounts.launch_state.escrow_sol_bump;

    let launch_ai = ctx.accounts.launch_state.to_account_info();

    let launch_signer_seeds: &[&[u8]] = &[
        b"launch_state",
        mint.as_ref(),
        &[launch_bump],
    ];

    let escrow_signer_seeds: &[&[u8]] = &[
        b"escrow_sol",
        mint.as_ref(),
        &[escrow_bump],
    ];

    let st = &mut ctx.accounts.launch_state;

    // --------------------------------------------------
    // state gates
    // --------------------------------------------------
    require!(
        st.state == LaunchPhase::PendingDevBuy as u8,
        AapedError::InvalidState
    );
    require!(!st.dev_buy_done, AapedError::InvalidState);

    require_keys_eq!(
        ctx.accounts.platform_wallet.key(),
        PLATFORM_WALLET,
        AapedError::PlatformMismatch
    );

    // --------------------------------------------------
    // sale inventory checks
    // --------------------------------------------------
    let sale_remaining: u128 = st
        .sale_supply
        .checked_sub(st.tokens_sold)
        .ok_or(AapedError::MathOverflow)? as u128;

    require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);
    require!(
        (min_tokens_out as u128) <= sale_remaining,
        AapedError::InsufficientSaleLiquidity
    );

    let sol_in_u128: u128 = sol_in as u128;

    // --------------------------------------------------
    // fee config
    // --------------------------------------------------
    let base_fee_bps: u128 = st.fee_total_bps as u128;
    let plat_bps: u128 = st.fee_platform_bps as u128;

    let base_fee_max = bps_amount(sol_in_u128, base_fee_bps)?;
    let sol_eff_max = sol_in_u128
        .checked_sub(base_fee_max)
        .ok_or(AapedError::MathOverflow)?;

    // --------------------------------------------------
    // curve quote
    // --------------------------------------------------
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

    require!(
        tokens_out >= min_tokens_out as u128,
        AapedError::SlippageExceeded
    );

    // gross actually consumed from escrow
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

    let treasury_amount = sol_eff_used;

    // --------------------------------------------------
    // escrow balance check
    // escrow must cover the actual used amount + keep rent alive
    // --------------------------------------------------
    let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(0) as u128;
    let escrow_lamports = escrow_ai.lamports() as u128;
    let transferable = escrow_lamports.saturating_sub(rent_min);

    require!(
        transferable >= sol_in_used,
        AapedError::InsufficientTreasuryLiquidity
    );

    // --------------------------------------------------
    // transfers FROM ESCROW PDA
    // --------------------------------------------------

    // creator fee -> creator PDA
    if creator_fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.escrow_sol_vault.to_account_info(),
                    to: ctx.accounts.creator_sol_vault.to_account_info(),
                },
                &[escrow_signer_seeds],
            ),
            creator_fee as u64,
        )?;
    }

    // platform fee -> platform wallet
    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.escrow_sol_vault.to_account_info(),
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
                &[escrow_signer_seeds],
            ),
            platform_fee as u64,
        )?;
    }

    // treasury net -> treasury PDA
    if treasury_amount > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.escrow_sol_vault.to_account_info(),
                    to: ctx.accounts.treasury_sol_vault.to_account_info(),
                },
                &[escrow_signer_seeds],
            ),
            treasury_amount as u64,
        )?;
    }

    // --------------------------------------------------
    // token delivery to dev ATA
    // --------------------------------------------------
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sale_vault.to_account_info(),
                to: ctx.accounts.dev_ata.to_account_info(),
                authority: launch_ai,
            },
            &[launch_signer_seeds],
        ),
        tokens_out as u64,
    )?;

    ctx.accounts.sale_vault.reload()?;

    // --------------------------------------------------
    // accounting
    // --------------------------------------------------
    st.tokens_sold = st
        .tokens_sold
        .checked_add(tokens_out as u64)
        .ok_or(AapedError::MathOverflow)?;

    st.sol_collected = st
        .sol_collected
        .checked_add(sol_eff_used)
        .ok_or(AapedError::MathOverflow)?;

    st.last_trade_ts = Clock::get()?.unix_timestamp;

    require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

    // --------------------------------------------------
    // activate curve
    // --------------------------------------------------
    st.dev_buy_done = true;
    st.state = LaunchPhase::Curve as u8;

    let curve_change_u128 = V_SOL
        .checked_add(sol_in_used)
        .ok_or(AapedError::MathOverflow)?;
    require!(
        curve_change_u128 <= u64::MAX as u128,
        AapedError::MathOverflow
    );

    emit!(CreatedTxn {
        mint,
        ipfs_cid,
        devbuy: sol_in_used as u64,
        curve_change: curve_change_u128 as u64,
    });

    Ok(())
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let launch_ai = ctx.accounts.launch_state.to_account_info();

    let st = &mut ctx.accounts.launch_state;

    require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

    // hard-lock platform receiver
    require_keys_eq!(
        ctx.accounts.platform_wallet.key(),
        PLATFORM_WALLET,
        AapedError::PlatformMismatch
    );

    // Cache account infos (compute optimization)
    
    let mint = st.mint;
    let bump = st.bump;

    let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

    let sale_remaining: u128 = st
    .sale_supply
    .checked_sub(st.tokens_sold)
    .ok_or(AapedError::MathOverflow)? as u128;

    require!(sale_remaining > 0, AapedError::InsufficientSaleLiquidity);

    require!(
        (min_tokens_out as u128) <= sale_remaining,
        AapedError::InsufficientSaleLiquidity
    );

    let sol_in_u128: u128 = sol_in as u128;

    let base_fee_bps: u128 = st.fee_total_bps as u128;
    let plat_bps: u128 = st.fee_platform_bps as u128;

    // Effective SOL after base fee
    let base_fee_max = bps_amount(sol_in_u128, base_fee_bps)?;

    let sol_eff_max = sol_in_u128
        .checked_sub(base_fee_max)
        .ok_or(AapedError::MathOverflow)?;

    // Curve quote
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

    // Gross actually used
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

    let treasury_amount = sol_eff_used;

    // Creator fee
    if creator_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program_ai.clone(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.creator_sol_vault.to_account_info(),
                },
            ),
            creator_fee as u64,
        )?;
    }

    // Platform fee
    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program_ai.clone(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
            ),
            platform_fee as u64,
        )?;
    }

    // Treasury
    if treasury_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program_ai.clone(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury_sol_vault.to_account_info(),
                },
            ),
            treasury_amount as u64,
        )?;
    }

    // Deliver tokens
    token::transfer(
        CpiContext::new_with_signer(
            token_program_ai,
            Transfer {
                from: ctx.accounts.sale_vault.to_account_info(),
                to: ctx.accounts.buyer_ata.to_account_info(),
                authority: launch_ai,
            },
            &[signer_seeds],
        ),
        tokens_out as u64,
    )?;

    // Reload ONLY sale_vault (needed for migration check)
    ctx.accounts.sale_vault.reload()?;

    // Accounting
    st.tokens_sold = st
        .tokens_sold
        .checked_add(tokens_out as u64)
        .ok_or(AapedError::MathOverflow)?;

    st.sol_collected = st
        .sol_collected
        .checked_add(sol_eff_used as u128)
        .ok_or(AapedError::MathOverflow)?;

    st.last_trade_ts = Clock::get()?.unix_timestamp;

    require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

    // Migration snapshot when curve completes
    if ctx.accounts.sale_vault.amount == 0 {
        require!(st.tokens_sold == st.sale_supply, AapedError::MathOverflow);

        let amm_initial_sol = ctx.accounts.treasury_sol_vault.lamports();
        let amm_initial_tok = ctx.accounts.lp_vault.amount;

        require!(amm_initial_sol > 0, AapedError::InsufficientTreasuryLiquidity);
        require!(amm_initial_tok > 0, AapedError::InsufficientSaleLiquidity);

        st.amm_initial_sol = amm_initial_sol;
        st.amm_initial_tok = amm_initial_tok;
        st.migrated_at = Clock::get()?.unix_timestamp;

        st.state = LaunchPhase::AmmLive as u8;

        emit!(MigratedEvent { mint: st.mint });
    }

    emit!(BuyEvent {
        mint,
        amount: sol_in,
    });

    Ok(())
    }
    
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, AapedError::InvalidAmount);

    let mint = ctx.accounts.launch_state.mint;
    let treasury_bump = ctx.accounts.launch_state.treasury_sol_bump;
    let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

    let st = &mut ctx.accounts.launch_state;

    require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);
    require_keys_eq!(ctx.accounts.platform_wallet.key(), PLATFORM_WALLET, AapedError::PlatformMismatch);

    require!(ctx.accounts.seller_ata.amount >= tokens_in, AapedError::InsufficientSaleLiquidity);

    let treasury_lamports: u128 = ctx.accounts.treasury_sol_vault.lamports() as u128;

    let sol_real: u128 = treasury_lamports;
    let tok_real: u128 = st
    .sale_supply
    .checked_sub(st.tokens_sold)
    .ok_or(AapedError::MathOverflow)? as u128;

    let sol_gross: u128 = curve_sell_gross(tokens_in as u128, sol_real, tok_real)?;
    require!(sol_gross > 0, AapedError::ZeroOutput);
    require!(sol_real >= sol_gross, AapedError::InsufficientTreasuryLiquidity);

    let base_fee: u128 = bps_amount(sol_gross, st.fee_total_bps as u128)?;
    let platform_fee: u128 = bps_amount(sol_gross, st.fee_platform_bps as u128)?;
    let creator_fee: u128 = base_fee.checked_sub(platform_fee).ok_or(AapedError::MathOverflow)?;

    let sol_net: u128 = sol_gross
    .checked_sub(base_fee)
    .ok_or(AapedError::MathOverflow)?;

    require!(sol_net >= min_sol_out as u128, AapedError::SlippageExceeded);

    // tokens back into sale vault
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

    // payout to seller
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

    // creator fee -> creator PDA vault
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

    // platform fee -> platform wallet direct
    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.treasury_sol_vault.to_account_info(),
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
                &[treasury_seeds],
            ),
            platform_fee as u64,
        )?;
    }

    st.tokens_sold = st.tokens_sold.checked_sub(tokens_in).ok_or(AapedError::MathOverflow)?;
    st.sol_collected = st.sol_collected.checked_sub(sol_gross).ok_or(AapedError::MathOverflow)?;
    st.last_trade_ts = Clock::get()?.unix_timestamp;

    emit!(SellEvent { mint, amount: tokens_in });

    Ok(())
    }
    
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let st = &ctx.accounts.launch_state;

    require_keys_eq!(
        ctx.accounts.creator_receiver.key(),
        st.creator,
        AapedError::InvalidFeeReceiver
    );

    let mint = st.mint;

    let swept = sweep_pda_to_return_amount(
        &ctx.accounts.system_program,
        &ctx.accounts.creator_sol_vault,
        &ctx.accounts.creator_receiver,
        &[b"creator_sol", mint.as_ref(), &[st.creator_sol_bump]],
    )?;

    emit!(ClaimfeesEvent {
        mint,
        creator: ctx.accounts.creator_receiver.key(),
        amount: swept,
    });

    Ok(())
}
    pub fn amm_buy(ctx: Context<AmmBuyCtx>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
    require!(sol_in > 0, AapedError::InvalidAmount);

    let st = &mut ctx.accounts.launch_state;
    require!(st.state == LaunchPhase::AmmLive as u8, AapedError::InvalidState);

    let sol_reserve = ctx.accounts.treasury_sol_vault.lamports() as u128;
    let tok_reserve = ctx.accounts.lp_vault.amount as u128;

    // fee breakdown
    let sol_in_u128 = sol_in as u128;

    let (sol_trade, lp_fee, creator_fee, platform_fee) = amm_quote_buy(sol_in_u128)?;

    let tokens_out = amm_buy_tokens_out(sol_trade, sol_reserve, tok_reserve)?;

    require!(tokens_out >= min_tokens_out as u128, AapedError::SlippageExceeded);

    // SOL going into pool (trade + LP growth)
    let sol_to_pool = sol_trade
        .checked_add(lp_fee)
        .ok_or(AapedError::MathOverflow)?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury_sol_vault.to_account_info(),
            },
        ),
        sol_to_pool as u64,
    )?;

    // creator fee
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

    // platform fee
    if platform_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
            ),
            platform_fee as u64,
        )?;
    }

    // token out
    let mint = st.mint;
    let bump = st.bump;

    let launch_ai = ctx.accounts.launch_state.to_account_info();
    let seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.lp_vault.to_account_info(),
                to: ctx.accounts.buyer_ata.to_account_info(),
                authority: launch_ai,
            },
            &[seeds],
        ),
        tokens_out as u64,
    )?;

    emit!(AmmBuyEvent {
        mint,
        amount: sol_in,
    });

    Ok(())
    }

    pub fn amm_sell(ctx: Context<AmmSellCtx>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
    require!(tokens_in > 0, AapedError::InvalidAmount);

    let st = &mut ctx.accounts.launch_state;
    require!(st.state == LaunchPhase::AmmLive as u8, AapedError::InvalidState);

    // --------------------------------------------------
    // Read PRE-TRADE reserves
    // --------------------------------------------------
    let sol_reserve_before: u128 = ctx.accounts.treasury_sol_vault.lamports() as u128;
    let tok_reserve_before: u128 = ctx.accounts.lp_vault.amount as u128;

    require!(tok_reserve_before > 0, AapedError::InsufficientSaleLiquidity);
    require!(sol_reserve_before > 0, AapedError::InsufficientTreasuryLiquidity);

    // --------------------------------------------------
    // Quote gross SOL out from pre-trade reserves
    // --------------------------------------------------
    let sol_gross: u128 =
        amm_sell_sol_out_gross(tokens_in as u128, sol_reserve_before, tok_reserve_before)?;
    require!(sol_gross > 0, AapedError::ZeroOutput);

    // --------------------------------------------------
    // AMM fee split from gross output
    // total = 1.0%
    // lp      0.6%  = 6 / 1000
    // creator 0.3%  = 3 / 1000
    // platform 0.1% = 1 / 1000
    //
    // LP fee stays inside treasury_sol_vault
    // --------------------------------------------------
    let lp_fee: u128 = sol_gross
        .checked_mul(6)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(1000)
        .ok_or(AapedError::MathOverflow)?;

    let creator_fee: u128 = sol_gross
        .checked_mul(3)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(1000)
        .ok_or(AapedError::MathOverflow)?;

    let platform_fee: u128 = sol_gross
        .checked_mul(1)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(1000)
        .ok_or(AapedError::MathOverflow)?;

    let total_fees = lp_fee
        .checked_add(creator_fee)
        .ok_or(AapedError::MathOverflow)?
        .checked_add(platform_fee)
        .ok_or(AapedError::MathOverflow)?;

    require!(total_fees <= sol_gross, AapedError::MathOverflow);

    let sol_net: u128 = sol_gross
        .checked_sub(total_fees)
        .ok_or(AapedError::MathOverflow)?;

    require!(sol_net >= min_sol_out as u128, AapedError::SlippageExceeded);

    // Only seller + creator + platform leave the pool.
    // LP fee remains in treasury_sol_vault.
    let actual_outflow = sol_net
        .checked_add(creator_fee)
        .ok_or(AapedError::MathOverflow)?
        .checked_add(platform_fee)
        .ok_or(AapedError::MathOverflow)?;

    require!(
        actual_outflow <= sol_reserve_before,
        AapedError::InsufficientTreasuryLiquidity
    );

    // --------------------------------------------------
    // Transfer tokens INTO the pool
    // --------------------------------------------------
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.seller_ata.to_account_info(),
                to: ctx.accounts.lp_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        tokens_in,
    )?;

    // --------------------------------------------------
    // Pay SOL OUT from treasury pool
    // LP fee is not transferred anywhere — it stays in pool
    // --------------------------------------------------
    let mint = st.mint;
    let treasury_bump = st.treasury_sol_bump;
    let treasury_seeds: &[&[u8]] = &[b"treasury_sol", mint.as_ref(), &[treasury_bump]];

    if sol_net > 0 {
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
    }

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
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
                &[treasury_seeds],
            ),
            platform_fee as u64,
        )?;
    }

    // --------------------------------------------------
    // Accounting
    // --------------------------------------------------
    st.last_trade_ts = Clock::get()?.unix_timestamp;

    emit!(AmmSellEvent {
        mint,
        amount: tokens_in,
    });

    Ok(())
    }
    
    pub fn settle_escrow_to_platform(ctx: Context<SettleEscrow>) -> Result<()> {
    let st = &mut ctx.accounts.launch_state;
    let mint = st.mint;

    // must be post-devbuy, and one-time only
    require!(st.dev_buy_done, AapedError::InvalidState);
    require!(!st.escrow_settled, AapedError::InvalidState);

    // must match the platform stored in state (and your hardcoded wallet)
    require_keys_eq!(st.platform, PLATFORM_WALLET, AapedError::PlatformMismatch);
    require_keys_eq!(ctx.accounts.platform_receiver.key(), st.platform, AapedError::InvalidFeeReceiver);

    // drain escrow (leave rent min so account stays alive)
    let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
    let platform_ai = ctx.accounts.platform_receiver.to_account_info();

    let rent_min = Rent::get()?.minimum_balance(0);
    let escrow_lamports = escrow_ai.lamports();
    let transferable = escrow_lamports.saturating_sub(rent_min);

    require!(transferable > 0, AapedError::InvalidAmount);

    let escrow_bump = st.escrow_sol_bump;
    let seeds: &[&[u8]] = &[b"escrow_sol", mint.as_ref(), &[escrow_bump]];

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: escrow_ai,
                to: platform_ai,
            },
            &[seeds],
        ),
        transferable,
    )?;

    st.escrow_settled = true;

    Ok(())
    }
}
    
    fn sweep_pda_to_return_amount<'info>(
    system_program: &Program<'info, System>,
    from_pda: &UncheckedAccount<'info>,
    to: &UncheckedAccount<'info>,
    signer_seeds: &[&[u8]],
) -> Result<u64> {
    require_keys_eq!(
        *from_pda.to_account_info().owner,
        system_program::ID,
        AapedError::InvalidVault
    );

    let from_lamports = from_pda.to_account_info().lamports();
    let rent_min = Rent::get()?.minimum_balance(from_pda.to_account_info().data_len());
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

    Ok(transferable)
}
// -----------------------------
// helper: create system-owned PDA account (rent exempt, 0 space)
// (used to create escrow in TX0)
// -----------------------------
fn create_pda_system_account<'info>(
    payer: &Signer<'info>,
    pda: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<()> {
    // If it already exists, sanity-check it matches what we expect.
    if pda.to_account_info().lamports() > 0 {
        require_keys_eq!(
            *pda.to_account_info().owner,
            system_program::ID,
            AapedError::InvalidVault
        );
        require!(
            pda.to_account_info().data_len() == space,
            AapedError::InvalidVault
        );
        return Ok(());
    }

    let lamports = rent.minimum_balance(space);

    // Create a system-owned PDA using payer as funding source.
    // The PDA "signs" via invoke_signed(seeds).
    let ix = system_instruction::create_account(
        &payer.key(),
        &pda.key(),
        lamports,
        space as u64,
        &system_program::ID,
    );

    invoke_signed(
        &ix,
        &[
            payer.to_account_info(),
            pda.to_account_info(),
            system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    Ok(())
}

// -----------------------------
// helper: create PDA account funded by escrow PDA
// - owner can be System / Token / this program
// -----------------------------
fn create_pda_account_from_escrow<'info>(
    escrow: &UncheckedAccount<'info>,
    pda: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    space: usize,
    owner: &Pubkey,
    pda_seeds: &[&[u8]],
    escrow_signer_seeds: &[&[u8]],
) -> Result<()> {
    // If it already exists, sanity-check it matches expected owner + size.
    if pda.to_account_info().lamports() > 0 {
        require_keys_eq!(
            *pda.to_account_info().owner,
            *owner,
            AapedError::InvalidVault
        );
        require!(
            pda.to_account_info().data_len() == space,
            AapedError::InvalidVault
        );
        return Ok(());
    }

    let lamports = rent.minimum_balance(space);

    // Escrow PDA funds the new PDA account.
    // Both PDAs sign:
    // - escrow_signer_seeds signs as the payer
    // - pda_seeds signs as the new account address (PDA)
    let ix = system_instruction::create_account(
        &escrow.key(),
        &pda.key(),
        lamports,
        space as u64,
        owner,
    );

    invoke_signed(
        &ix,
        &[
            escrow.to_account_info(),
            pda.to_account_info(),
            system_program.to_account_info(),
        ],
        &[
            escrow_signer_seeds, // payer PDA signs
            pda_seeds,           // new PDA signs
        ],
    )?;

    Ok(())
}

// -----------------------------
// accounts
// -----------------------------

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    /// Platform must sign this instruction
    #[account(mut)]
    pub platform_signer: Signer<'info>,

    /// Mint authority wallet (for now: PLATFORM_WALLET)
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: created manually (program-owned)
    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump
    )]
    pub launch_state: UncheckedAccount<'info>,

    /// CHECK: created manually (token-owned)
    #[account(
        mut,
        seeds = [b"sale_vault", mint.key().as_ref()],
        bump
    )]
    pub sale_vault: UncheckedAccount<'info>,

    /// CHECK: created manually (token-owned)
    #[account(
        mut,
        seeds = [b"lp_vault", mint.key().as_ref()],
        bump
    )]
    pub lp_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, seeds = [b"treasury_sol", mint.key().as_ref()], bump)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, seeds = [b"creator_sol", mint.key().as_ref()], bump)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK — must already exist and be funded (TX0)
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

    /// CHECK
    #[account(mut, seeds = [b"escrow_sol", mint.key().as_ref()], bump)]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

    /// CHECK: platform wallet
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

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

    #[account(mut, has_one = sale_vault, has_one = lp_vault)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.sale_vault)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK: hard-locked platform wallet (direct fee receiver)
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

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

    /// CHECK: hard-locked platform wallet (direct fee receiver)
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK: must equal st.creator (you already enforce in handler)
    #[account(mut)]
    pub creator_receiver: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    /// Platform must sign (hard lock)
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: must equal launch_state.platform (which must be PLATFORM_WALLET)
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_receiver: UncheckedAccount<'info>,

    /// CHECK: escrow PDA holding SOL
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_state.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// used by initialize_metadata
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MetadataParams {
    pub name: String,
    pub symbol: String,
    pub uri: String,
 }

    #[derive(Accounts)]
pub struct AmmBuyCtx<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

    #[derive(Accounts)]
pub struct AmmSellCtx<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_ata: Account<'info, TokenAccount>,

    /// CHECK
    #[account(mut, address = launch_state.treasury_sol_vault)]
    pub treasury_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = launch_state.creator_sol_vault)]
    pub creator_sol_vault: UncheckedAccount<'info>,

    /// CHECK
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    }
