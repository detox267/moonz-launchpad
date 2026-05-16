use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::{system_instruction, sysvar};
use anchor_lang::system_program;
use solana_security_txt::security_txt;

use anchor_lang::{AccountDeserialize, AccountSerialize};

pub mod errors;
pub mod math;
pub mod state;

use crate::errors::AapedError;
use crate::math::*;
use crate::state::*;

use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

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

/// Platform wallet fee receiver.
/// Platform/admin wallet.
/// Used for platform-signed admin execution.
pub const PLATFORM_WALLET: Pubkey =
    pubkey!("ELZ5aiHLxnaTmbazgbmoSCVS6SyvJ7DbXTDxq682PuKt");

/// Separate launch-fee receiver.
/// Leftover escrow SOL after account setup settles here for IPFS/storage kitty.
pub const LAUNCH_FEE_WALLET: Pubkey =
    pubkey!("7Ky9cCM29q4pGThCLfJz7fBKVZZNHYtB7EbThZU9uQRC");

/// Flat creator launch fee.
/// 0.04 SOL. This includes account setup/rent funding and storage/IPFS kitty.
pub const CREATE_FEE_LAMPORTS: u64 = 40_000_000;

/// Refund timeout for failed launches.
/// If the platform/backend does not execute the launch, creator can refund after this delay.
pub const LAUNCH_REFUND_TIMEOUT_SECONDS: i64 = 30; // 30 seconds

/// Mainnet WSOL mint.
pub const WSOL_MINT: Pubkey =
    pubkey!("So11111111111111111111111111111111111111112");

/// Mainnet USDC mint.
/// If testing locally/devnet, replace this in that deployment build.
pub const USDC_MINT: Pubkey =
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Static PDA seed for mint authority.
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";

/// AMM type. Basket / LP-share mode removed from lib.rs.
pub const AMM_TYPE_NORMAL: u8 = 0;

/// Quote asset selector.
/// Frontend can show WSOL mode as “SOL”.
pub const QUOTE_ASSET_WSOL: u8 = 0;
pub const QUOTE_ASSET_USDC: u8 = 1;

/// Pool quote-asset switch cooldown: 24 hours.
pub const POOL_SWITCH_COOLDOWN_SECONDS: i64 = 86_400;

/// Fixed pool switch fee: 0.5 SOL.
/// Creator pays this in native SOL when starting a switch.
pub const POOL_SWITCH_FEE_LAMPORTS: u64 = 500_000_000;

/// Total trading fee: 1.25%.
pub const TRADE_FEE_TOTAL_BPS: u16 = 125;

/// Fee-share basis points use 10_000 = 100% of the fee.
///
/// Bonding fee split:
/// 30% platform
/// 70% creator
pub const BONDING_PLATFORM_SHARE_BPS: u16 = 3_000;
pub const BONDING_CREATOR_SHARE_BPS: u16 = 7_000;

/// AMM fee split:
/// 25% platform
/// 37.5% creator
/// 37.5% LP reserve
pub const AMM_PLATFORM_SHARE_BPS: u16 = 2_500;
pub const AMM_CREATOR_SHARE_BPS: u16 = 3_750;
pub const AMM_LP_SHARE_BPS: u16 = 3_750;

// -------------------- TOKENOMICS --------------------

pub const TOTAL_TOKENS: u64 = 1_000_000_000;
pub const SALE_TOKENS: u64 = 650_000_000;
pub const LP_TOKENS: u64 = 350_000_000;

// -------------------- HELPERS --------------------

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

    tokens
        .checked_mul(scale)
        .ok_or(AapedError::MathOverflow.into())
}

fn valid_quote_asset(asset: u8) -> bool {
    asset == QUOTE_ASSET_WSOL || asset == QUOTE_ASSET_USDC
}

fn split_bonding_fee(total_fee: u128) -> Result<(u128, u128)> {
    let platform_fee = total_fee
        .checked_mul(BONDING_PLATFORM_SHARE_BPS as u128)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(AapedError::MathOverflow)?;

    let creator_fee = total_fee
        .checked_sub(platform_fee)
        .ok_or(AapedError::MathOverflow)?;

    Ok((creator_fee, platform_fee))
}

fn split_amm_fee(total_fee: u128) -> Result<(u128, u128, u128)> {
    let platform_fee = total_fee
        .checked_mul(AMM_PLATFORM_SHARE_BPS as u128)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(AapedError::MathOverflow)?;

    let creator_fee = total_fee
        .checked_mul(AMM_CREATOR_SHARE_BPS as u128)
        .ok_or(AapedError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(AapedError::MathOverflow)?;

    let used = platform_fee
        .checked_add(creator_fee)
        .ok_or(AapedError::MathOverflow)?;

    let lp_fee = total_fee
        .checked_sub(used)
        .ok_or(AapedError::MathOverflow)?;

    Ok((lp_fee, creator_fee, platform_fee))
}

// -------------------- EVENTS --------------------

#[event]
pub struct LaunchEscrowFundedEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub create_fee_lamports: u64,
    pub dev_buy_lamports: u64,
    pub deposited_lamports: u64,
}

#[event]
pub struct LaunchEscrowRefundedEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub refunded_lamports: u64,
}

#[event]
pub struct CreatedTxn {
    pub mint: Pubkey,
    pub devbuy: u64,
    pub curve_change: u64,
    pub ipfs_cid: String,
}

#[event]
pub struct BuyEvent {
    pub mint: Pubkey,
    pub amount: u64,
    pub quote_asset: u8,
}

#[event]
pub struct SellEvent {
    pub mint: Pubkey,
    pub amount: u64,
    pub quote_asset: u8,
}

#[event]
pub struct ClaimfeesEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AmmBuyEvent {
    pub mint: Pubkey,
    pub amount: u64,
    pub quote_asset: u8,
}

#[event]
pub struct AmmSellEvent {
    pub mint: Pubkey,
    pub amount: u64,
    pub quote_asset: u8,
}

#[event]
pub struct MigratedEvent {
    pub mint: Pubkey,
}

#[event]
pub struct PoolSwitchStartedEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub from_asset: u8,
    pub to_asset: u8,
    pub switch_fee_lamports: u64,
}

#[event]
pub struct PoolSwitchCompletedEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub new_asset: u8,
}

#[program]
pub mod aaped_launch {
    use super::*;

    // ============================================================
    // TX0: user funds escrow PDA
    // ============================================================
    // Native SOL is only used here for account creation / rent funding.
    // Trading itself uses WSOL from the start.

    pub fn initialize_launch(ctx: Context<InitializeLaunch>, params: InitializeParams) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            AapedError::Unauthorized
        );

        require_keys_eq!(
            params.platform,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.launch_escrow.creator,
            params.creator,
            AapedError::InvalidEscrowCreator
        );

        require_keys_eq!(
            ctx.accounts.launch_escrow.mint,
            ctx.accounts.mint.key(),
            AapedError::InvalidVault
        );

        require!(
            !ctx.accounts.launch_escrow.executed,
            AapedError::EscrowAlreadyExecuted
        );

        require!(
            !ctx.accounts.launch_escrow.refunded,
            AapedError::EscrowRefundUnavailable
        );

        require!(
            ctx.accounts.launch_escrow.deposited_lamports
                >= ctx.accounts
                    .launch_escrow
                    .create_fee_lamports
                    .checked_add(ctx.accounts.launch_escrow.dev_buy_lamports)
                    .ok_or(AapedError::MathOverflow)?,
            AapedError::EscrowNotFunded
        );

        require!(
            params.amm_type == AMM_TYPE_NORMAL,
            AapedError::InvalidAmount
        );

        require_keys_eq!(
            ctx.accounts.wsol_mint.key(),
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            USDC_MINT,
            AapedError::InvalidVault
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            AapedError::Unauthorized
        );

        let mint_auth = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(AapedError::Unauthorized)?;

        require_keys_eq!(
            mint_auth,
            expected_mint_authority,
            AapedError::Unauthorized
        );

        require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
        require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
        require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

        let mint_key = ctx.accounts.mint.key();
        let decimals = ctx.accounts.mint.decimals;

        let total_supply_locked = to_base_units(TOTAL_TOKENS, decimals)?;
        let sale_supply_locked = to_base_units(SALE_TOKENS, decimals)?;
        let lp_supply_locked = to_base_units(LP_TOKENS, decimals)?;

        require!(
            sale_supply_locked
                .checked_add(lp_supply_locked)
                .ok_or(AapedError::MathOverflow)?
                == total_supply_locked,
            AapedError::MathOverflow
        );

        require!(
            params.total_supply == total_supply_locked,
            AapedError::InvalidAmount
        );

        require!(
            params.sale_supply == sale_supply_locked,
            AapedError::InvalidAmount
        );

        require!(
            params.lp_supply == lp_supply_locked,
            AapedError::InvalidAmount
        );

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

        create_pda_account_from_escrow(
            &ctx.accounts.escrow_sol_vault,
            &ctx.accounts.treasury_wsol_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            anchor_spl::token::TokenAccount::LEN,
            &ctx.accounts.token_program.key(),
            &[
                b"treasury_wsol",
                mint_key.as_ref(),
                &[ctx.bumps.treasury_wsol_vault],
            ],
            escrow_seeds,
        )?;

        create_pda_account_from_escrow(
            &ctx.accounts.escrow_sol_vault,
            &ctx.accounts.treasury_usdc_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            anchor_spl::token::TokenAccount::LEN,
            &ctx.accounts.token_program.key(),
            &[
                b"treasury_usdc",
                mint_key.as_ref(),
                &[ctx.bumps.treasury_usdc_vault],
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

            let ix_wsol = anchor_spl::token::spl_token::instruction::initialize_account3(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.treasury_wsol_vault.key(),
                &ctx.accounts.wsol_mint.key(),
                &launch_state_key,
            )?;

            invoke(
                &ix_wsol,
                &[
                    ctx.accounts.treasury_wsol_vault.to_account_info(),
                    ctx.accounts.wsol_mint.to_account_info(),
                    ctx.accounts.rent.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                ],
            )?;

            let ix_usdc = anchor_spl::token::spl_token::instruction::initialize_account3(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.treasury_usdc_vault.key(),
                &ctx.accounts.usdc_mint.key(),
                &launch_state_key,
            )?;

            invoke(
                &ix_usdc,
                &[
                    ctx.accounts.treasury_usdc_vault.to_account_info(),
                    ctx.accounts.usdc_mint.to_account_info(),
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

        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let mut st: LaunchState =
            LaunchState::try_deserialize_unchecked(&mut &launch_ai.data.borrow()[..])?;

        st.bump = ctx.bumps.launch_state;
        st.treasury_wsol_bump = ctx.bumps.treasury_wsol_vault;
        st.treasury_usdc_bump = ctx.bumps.treasury_usdc_vault;
        st.escrow_sol_bump = ctx.bumps.escrow_sol_vault;

        st.state = LaunchPhase::PendingDevBuy as u8;

        st.mint = mint_key;
        st.creator = params.creator;
        st.platform = PLATFORM_WALLET;
        st.core_authority = params.core_authority;

        st.total_supply = total_supply_locked;
        st.sale_supply = sale_supply_locked;
        st.lp_supply = lp_supply_locked;

        st.amm_initial_sol = 0;
        st.amm_initial_tok = 0;
        st.migrated_at = 0;

        st.amm_type = AMM_TYPE_NORMAL;
        st.lp_share_claim_base = 0;

        st.quote_asset = QUOTE_ASSET_WSOL;
        st.pending_quote_asset = QUOTE_ASSET_WSOL;
        st.last_pool_switch_ts = 0;
        st.switch_started_at = 0;

        st.fee_total_bps = TRADE_FEE_TOTAL_BPS;
        st.fee_creator_bps = BONDING_CREATOR_SHARE_BPS;
        st.fee_platform_bps = BONDING_PLATFORM_SHARE_BPS;

        st.tokens_sold = 0;
        st.sol_collected = 0;

        st.sale_vault = ctx.accounts.sale_vault.key();
        st.lp_vault = ctx.accounts.lp_vault.key();

        st.treasury_wsol_vault = ctx.accounts.treasury_wsol_vault.key();
        st.treasury_usdc_vault = ctx.accounts.treasury_usdc_vault.key();
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

        let mint_auth_seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            &[mint_auth_bump],
        ];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.sale_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[mint_auth_seeds],
            ),
            sale_supply_locked,
        )?;

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.lp_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[mint_auth_seeds],
            ),
            lp_supply_locked,
        )?;

        Ok(())
    }

    pub fn initialize_metadata(
        ctx: Context<InitializeMetadata>,
        _metadata_bump: u8,
        params: MetadataParams,
    ) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(
            st.mint,
            ctx.accounts.mint.key(),
            AapedError::InvalidVault
        );

        require_keys_eq!(
            st.metadata,
            ctx.accounts.metadata.key(),
            AapedError::InvalidVault
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            AapedError::Unauthorized
        );

        let mint_auth = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(AapedError::Unauthorized)?;

        require_keys_eq!(
            mint_auth,
            expected_mint_authority,
            AapedError::Unauthorized
        );

        require!(params.name.as_bytes().len() <= 32, AapedError::InvalidAmount);
        require!(params.symbol.as_bytes().len() <= 10, AapedError::InvalidAmount);
        require!(params.uri.as_bytes().len() <= 200, AapedError::InvalidAmount);

        use mpl_token_metadata::instructions::{
            CreateMetadataAccountV3,
            CreateMetadataAccountV3InstructionArgs,
        };

        let data = DataV2 {
            name: params.name.clone(),
            symbol: params.symbol.clone(),
            uri: params.uri.clone(),
            seller_fee_basis_points: 0,
            creators: Some(vec![Creator {
                address: st.creator,
                verified: false,
                share: 100,
            }]),
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

        let mint_auth_seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            &[mint_auth_bump],
        ];

        invoke_signed(
            &create_ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[mint_auth_seeds],
        )?;

        Ok(())
    }

    pub fn finalize_mint_authorities(
        ctx: Context<FinalizeMintAuthorities>,
        _metadata_bump: u8,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.launch_state.metadata,
            ctx.accounts.metadata.key(),
            AapedError::InvalidVault
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            AapedError::Unauthorized
        );

        let mint_auth_seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            &[mint_auth_bump],
        ];

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[mint_auth_seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[mint_auth_seeds],
            ),
            AuthorityType::FreezeAccount,
            None,
        )?;

        Ok(())
    }

    // ============================================================
    // Bonding curve - WSOL quote
    // ============================================================

    pub fn buy(ctx: Context<Buy>, wsol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(wsol_in > 0, AapedError::InvalidAmount);

        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let st = &mut ctx.accounts.launch_state;

        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        require_keys_eq!(
            ctx.accounts.buyer_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        let mint = st.mint;
        let bump = st.bump;

        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        let sale_remaining: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(AapedError::MathOverflow)? as u128;

        require!(
            sale_remaining > 0,
            AapedError::InsufficientSaleLiquidity
        );

        require!(
            (min_tokens_out as u128) <= sale_remaining,
            AapedError::InsufficientSaleLiquidity
        );

        let wsol_in_u128: u128 = wsol_in as u128;

        let base_fee_max =
            bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let wsol_eff_max = wsol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(AapedError::MathOverflow)?;

        let (tokens_out_raw, _, _) =
            curve_buy(wsol_eff_max, st.sol_collected as u128, sale_remaining, 0)?;

        require!(tokens_out_raw > 0, AapedError::ZeroOutput);

        let (tokens_out, wsol_eff_used): (u128, u128) =
            if tokens_out_raw <= sale_remaining {
                (tokens_out_raw, wsol_eff_max)
            } else {
                let wsol_eff_needed = curve_sol_eff_for_exact_tokens_cp(
                    sale_remaining,
                    st.sol_collected as u128,
                    sale_remaining,
                )?;

                (sale_remaining, wsol_eff_needed)
            };

        require!(
            tokens_out >= min_tokens_out as u128,
            AapedError::SlippageExceeded
        );

        let wsol_in_used =
            gross_from_net(wsol_eff_used, TRADE_FEE_TOTAL_BPS as u128)?;

        require!(wsol_in_used <= wsol_in_u128, AapedError::MathOverflow);

        let base_fee_used = wsol_in_used
            .checked_sub(wsol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        let (creator_fee, platform_fee) = split_bonding_fee(base_fee_used)?;

        let treasury_amount = wsol_eff_used;

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.creator_wsol_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                platform_fee as u64,
            )?;
        }

        if treasury_amount > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                treasury_amount as u64,
            )?;
        }

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

        ctx.accounts.sale_vault.reload()?;
        ctx.accounts.treasury_wsol_vault.reload()?;

        st.tokens_sold = st
            .tokens_sold
            .checked_add(tokens_out as u64)
            .ok_or(AapedError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_add(wsol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

        if ctx.accounts.sale_vault.amount == 0 {
            require!(st.tokens_sold == st.sale_supply, AapedError::MathOverflow);

            let amm_initial_wsol = ctx.accounts.treasury_wsol_vault.amount;
            let amm_initial_tok = ctx.accounts.lp_vault.amount;

            require!(
                amm_initial_wsol > 0,
                AapedError::InsufficientTreasuryLiquidity
            );

            require!(
                amm_initial_tok > 0,
                AapedError::InsufficientSaleLiquidity
            );

            st.amm_initial_sol = amm_initial_wsol;
            st.amm_initial_tok = amm_initial_tok;
            st.migrated_at = Clock::get()?.unix_timestamp;
            st.lp_share_claim_base = 0;

            st.quote_asset = QUOTE_ASSET_WSOL;
            st.pending_quote_asset = QUOTE_ASSET_WSOL;

            st.state = LaunchPhase::AmmLive as u8;

            emit!(MigratedEvent { mint: st.mint });
        }

        emit!(BuyEvent {
            mint,
            amount: wsol_in,
            quote_asset: QUOTE_ASSET_WSOL,
        });

        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_wsol_out: u64) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let launch_bump = ctx.accounts.launch_state.bump;

        let launch_seeds: &[&[u8]] =
            &[b"launch_state", mint.as_ref(), &[launch_bump]];

        let st = &mut ctx.accounts.launch_state;

        require!(st.state == LaunchPhase::Curve as u8, AapedError::InvalidState);

        require_keys_eq!(
            ctx.accounts.seller_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        require!(
            ctx.accounts.seller_ata.amount >= tokens_in,
            AapedError::InsufficientSaleLiquidity
        );

        let wsol_real: u128 = ctx.accounts.treasury_wsol_vault.amount as u128;

        let tok_real: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(AapedError::MathOverflow)? as u128;

        let wsol_gross: u128 =
            curve_sell_gross(tokens_in as u128, wsol_real, tok_real)?;

        require!(wsol_gross > 0, AapedError::ZeroOutput);

        require!(
            wsol_real >= wsol_gross,
            AapedError::InsufficientTreasuryLiquidity
        );

        let base_fee: u128 =
            bps_amount(wsol_gross, TRADE_FEE_TOTAL_BPS as u128)?;

        let (creator_fee, platform_fee) = split_bonding_fee(base_fee)?;

        let wsol_net: u128 = wsol_gross
            .checked_sub(base_fee)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            wsol_net >= min_wsol_out as u128,
            AapedError::SlippageExceeded
        );

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

        if wsol_net > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.seller_wsol_ata.to_account_info(),
                        authority: ctx.accounts.launch_state.to_account_info(),
                    },
                    &[launch_seeds],
                ),
                wsol_net as u64,
            )?;
        }

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.creator_wsol_ata.to_account_info(),
                        authority: ctx.accounts.launch_state.to_account_info(),
                    },
                    &[launch_seeds],
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                        authority: ctx.accounts.launch_state.to_account_info(),
                    },
                    &[launch_seeds],
                ),
                platform_fee as u64,
            )?;
        }

        st.tokens_sold = st
            .tokens_sold
            .checked_sub(tokens_in)
            .ok_or(AapedError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_sub(wsol_gross)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(SellEvent {
            mint,
            amount: tokens_in,
            quote_asset: QUOTE_ASSET_WSOL,
        });

        Ok(())
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let st = &ctx.accounts.launch_state;

        require_keys_eq!(
            ctx.accounts.creator_receiver.key(),
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        // Creator fees are now paid directly in WSOL or USDC during trades.
        // This function is kept as a harmless compatibility stub.
        emit!(ClaimfeesEvent {
            mint: st.mint,
            creator: ctx.accounts.creator_receiver.key(),
            amount: 0,
        });

        Ok(())
    }

    // ============================================================
    // Pool quote-asset switch control
    // ============================================================

    pub fn begin_pool_switch(
        ctx: Context<BeginPoolSwitch>,
        target_quote_asset: u8,
    ) -> Result<()> {
        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            AapedError::InvalidState
        );

        require!(
            valid_quote_asset(target_quote_asset),
            AapedError::InvalidAmount
        );

        require!(
            target_quote_asset != st.quote_asset,
            AapedError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.creator.key(),
            st.creator,
            AapedError::Unauthorized
        );

        require_keys_eq!(
            ctx.accounts.platform_wallet.key(),
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        let now = Clock::get()?.unix_timestamp;

        if st.last_pool_switch_ts > 0 {
            let elapsed = now
                .checked_sub(st.last_pool_switch_ts)
                .ok_or(AapedError::MathOverflow)?;

            require!(
                elapsed >= POOL_SWITCH_COOLDOWN_SECONDS,
                AapedError::SwitchCooldownActive
            );
        }

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.platform_wallet.to_account_info(),
                },
            ),
            POOL_SWITCH_FEE_LAMPORTS,
        )?;

        st.pending_quote_asset = target_quote_asset;
        st.switch_started_at = now;
        st.state = LaunchPhase::Switching as u8;

        emit!(PoolSwitchStartedEvent {
            mint: st.mint,
            creator: st.creator,
            from_asset: st.quote_asset,
            to_asset: target_quote_asset,
            switch_fee_lamports: POOL_SWITCH_FEE_LAMPORTS,
        });

        Ok(())
    }

    pub fn complete_pool_switch(ctx: Context<CompletePoolSwitch>) -> Result<()> {
        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::Switching as u8,
            AapedError::InvalidState
        );

        require!(
            valid_quote_asset(st.pending_quote_asset),
            AapedError::InvalidAmount
        );

        require_keys_eq!(
            ctx.accounts.creator.key(),
            st.creator,
            AapedError::Unauthorized
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        if st.pending_quote_asset == QUOTE_ASSET_WSOL {
            require!(
                ctx.accounts.treasury_wsol_vault.amount > 0,
                AapedError::InsufficientTreasuryLiquidity
            );
        }

        if st.pending_quote_asset == QUOTE_ASSET_USDC {
            require!(
                ctx.accounts.treasury_usdc_vault.amount > 0,
                AapedError::InsufficientTreasuryLiquidity
            );
        }

        st.quote_asset = st.pending_quote_asset;
        st.last_pool_switch_ts = Clock::get()?.unix_timestamp;
        st.switch_started_at = 0;
        st.state = LaunchPhase::AmmLive as u8;

        emit!(PoolSwitchCompletedEvent {
            mint: st.mint,
            creator: st.creator,
            new_asset: st.quote_asset,
        });

        Ok(())
    }

    // ============================================================
    // AMM - WSOL quote asset
    // ============================================================

    pub fn amm_buy(
        ctx: Context<AmmBuyCtx>,
        wsol_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        require!(wsol_in > 0, AapedError::InvalidAmount);

        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            AapedError::InvalidState
        );

        require!(
            st.amm_type == AMM_TYPE_NORMAL,
            AapedError::InvalidState
        );

        require!(
            st.quote_asset == QUOTE_ASSET_WSOL,
            AapedError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.buyer_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        let quote_reserve = ctx.accounts.treasury_wsol_vault.amount as u128;
        let tok_reserve = ctx.accounts.lp_vault.amount as u128;

        let wsol_in_u128 = wsol_in as u128;

        let total_fee =
            bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let wsol_trade = wsol_in_u128
            .checked_sub(total_fee)
            .ok_or(AapedError::MathOverflow)?;

        let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fee)?;

        let tokens_out =
            amm_buy_tokens_out(wsol_trade, quote_reserve, tok_reserve)?;

        require!(
            tokens_out >= min_tokens_out as u128,
            AapedError::SlippageExceeded
        );

        let wsol_to_pool = wsol_trade
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                    to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            wsol_to_pool as u64,
        )?;

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.creator_wsol_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                platform_fee as u64,
            )?;
        }

        let mint = st.mint;
        let bump = st.bump;
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let seeds: &[&[u8]] =
            &[b"launch_state", mint.as_ref(), &[bump]];

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

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(AmmBuyEvent {
            mint,
            amount: wsol_in,
            quote_asset: QUOTE_ASSET_WSOL,
        });

        Ok(())
    }

    pub fn amm_sell(
        ctx: Context<AmmSellCtx>,
        tokens_in: u64,
        min_wsol_out: u64,
    ) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            AapedError::InvalidState
        );

        require!(
            st.amm_type == AMM_TYPE_NORMAL,
            AapedError::InvalidState
        );

        require!(
            st.quote_asset == QUOTE_ASSET_WSOL,
            AapedError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.seller_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        let quote_reserve_before: u128 =
            ctx.accounts.treasury_wsol_vault.amount as u128;

        let tok_reserve_before: u128 =
            ctx.accounts.lp_vault.amount as u128;

        require!(
            tok_reserve_before > 0,
            AapedError::InsufficientSaleLiquidity
        );

        require!(
            quote_reserve_before > 0,
            AapedError::InsufficientTreasuryLiquidity
        );

        let wsol_gross: u128 =
            amm_sell_sol_out_gross(tokens_in as u128, quote_reserve_before, tok_reserve_before)?;

        require!(wsol_gross > 0, AapedError::ZeroOutput);

        let total_fees =
            bps_amount(wsol_gross, TRADE_FEE_TOTAL_BPS as u128)?;

        let (lp_fee, creator_fee, platform_fee) =
            split_amm_fee(total_fees)?;

        let wsol_net: u128 = wsol_gross
            .checked_sub(total_fees)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            wsol_net >= min_wsol_out as u128,
            AapedError::SlippageExceeded
        );

        let actual_outflow = wsol_net
            .checked_add(creator_fee)
            .ok_or(AapedError::MathOverflow)?
            .checked_add(platform_fee)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            actual_outflow <= quote_reserve_before,
            AapedError::InsufficientTreasuryLiquidity
        );

        let _lp_fee_stays_in_pool = lp_fee;

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

        let mint = st.mint;
        let bump = st.bump;
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let seeds: &[&[u8]] =
            &[b"launch_state", mint.as_ref(), &[bump]];

        if wsol_net > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.seller_wsol_ata.to_account_info(),
                        authority: launch_ai.clone(),
                    },
                    &[seeds],
                ),
                wsol_net as u64,
            )?;
        }

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.creator_wsol_ata.to_account_info(),
                        authority: launch_ai.clone(),
                    },
                    &[seeds],
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                        authority: launch_ai,
                    },
                    &[seeds],
                ),
                platform_fee as u64,
            )?;
        }

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(AmmSellEvent {
            mint,
            amount: tokens_in,
            quote_asset: QUOTE_ASSET_WSOL,
        });

        Ok(())
    }

    // ============================================================
    // AMM - USDC quote asset
    // ============================================================

    pub fn amm_buy_usdc(
        ctx: Context<AmmBuyUsdcCtx>,
        usdc_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        require!(usdc_in > 0, AapedError::InvalidAmount);

        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            AapedError::InvalidState
        );

        require!(
            st.amm_type == AMM_TYPE_NORMAL,
            AapedError::InvalidState
        );

        require!(
            st.quote_asset == QUOTE_ASSET_USDC,
            AapedError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.buyer_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_usdc_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        let quote_reserve = ctx.accounts.treasury_usdc_vault.amount as u128;
        let tok_reserve = ctx.accounts.lp_vault.amount as u128;
        let usdc_in_u128 = usdc_in as u128;

        let total_fee =
            bps_amount(usdc_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let usdc_trade = usdc_in_u128
            .checked_sub(total_fee)
            .ok_or(AapedError::MathOverflow)?;

        let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fee)?;

        let tokens_out =
            amm_buy_tokens_out(usdc_trade, quote_reserve, tok_reserve)?;

        require!(
            tokens_out >= min_tokens_out as u128,
            AapedError::SlippageExceeded
        );

        let usdc_to_pool = usdc_trade
            .checked_add(lp_fee)
            .ok_or(AapedError::MathOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_usdc_ata.to_account_info(),
                    to: ctx.accounts.treasury_usdc_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            usdc_to_pool as u64,
        )?;

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_usdc_ata.to_account_info(),
                        to: ctx.accounts.creator_usdc_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_usdc_ata.to_account_info(),
                        to: ctx.accounts.platform_usdc_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                platform_fee as u64,
            )?;
        }

        let mint = st.mint;
        let bump = st.bump;
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let seeds: &[&[u8]] =
            &[b"launch_state", mint.as_ref(), &[bump]];

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

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(AmmBuyEvent {
            mint,
            amount: usdc_in,
            quote_asset: QUOTE_ASSET_USDC,
        });

        Ok(())
    }

    pub fn amm_sell_usdc(
        ctx: Context<AmmSellUsdcCtx>,
        tokens_in: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        require!(tokens_in > 0, AapedError::InvalidAmount);

        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            AapedError::InvalidState
        );

        require!(
            st.amm_type == AMM_TYPE_NORMAL,
            AapedError::InvalidState
        );

        require!(
            st.quote_asset == QUOTE_ASSET_USDC,
            AapedError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.seller_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.mint,
            USDC_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            ctx.accounts.launch_state.key(),
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_usdc_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        let quote_reserve_before: u128 =
            ctx.accounts.treasury_usdc_vault.amount as u128;

        let tok_reserve_before: u128 =
            ctx.accounts.lp_vault.amount as u128;

        require!(
            tok_reserve_before > 0,
            AapedError::InsufficientSaleLiquidity
        );

        require!(
            quote_reserve_before > 0,
            AapedError::InsufficientTreasuryLiquidity
        );

        let usdc_gross: u128 =
            amm_sell_sol_out_gross(tokens_in as u128, quote_reserve_before, tok_reserve_before)?;

        require!(usdc_gross > 0, AapedError::ZeroOutput);

        let total_fees =
            bps_amount(usdc_gross, TRADE_FEE_TOTAL_BPS as u128)?;

        let (lp_fee, creator_fee, platform_fee) =
            split_amm_fee(total_fees)?;

        let usdc_net: u128 = usdc_gross
            .checked_sub(total_fees)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            usdc_net >= min_usdc_out as u128,
            AapedError::SlippageExceeded
        );

        let actual_outflow = usdc_net
            .checked_add(creator_fee)
            .ok_or(AapedError::MathOverflow)?
            .checked_add(platform_fee)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            actual_outflow <= quote_reserve_before,
            AapedError::InsufficientTreasuryLiquidity
        );

        let _lp_fee_stays_in_pool = lp_fee;

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

        let mint = st.mint;
        let bump = st.bump;
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let seeds: &[&[u8]] =
            &[b"launch_state", mint.as_ref(), &[bump]];

        if usdc_net > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_usdc_vault.to_account_info(),
                        to: ctx.accounts.seller_usdc_ata.to_account_info(),
                        authority: launch_ai.clone(),
                    },
                    &[seeds],
                ),
                usdc_net as u64,
            )?;
        }

        if creator_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_usdc_vault.to_account_info(),
                        to: ctx.accounts.creator_usdc_ata.to_account_info(),
                        authority: launch_ai.clone(),
                    },
                    &[seeds],
                ),
                creator_fee as u64,
            )?;
        }

        if platform_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.treasury_usdc_vault.to_account_info(),
                        to: ctx.accounts.platform_usdc_ata.to_account_info(),
                        authority: launch_ai,
                    },
                    &[seeds],
                ),
                platform_fee as u64,
            )?;
        }

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(AmmSellEvent {
            mint,
            amount: tokens_in,
            quote_asset: QUOTE_ASSET_USDC,
        });

        Ok(())
    }

    pub fn settle_escrow_to_platform(ctx: Context<SettleEscrow>) -> Result<()> {
        let st = &mut ctx.accounts.launch_state;
        let mint = st.mint;

        require!(st.dev_buy_done, AapedError::InvalidState);
        require!(!st.escrow_settled, AapedError::InvalidState);

        require_keys_eq!(
            ctx.accounts.launch_escrow.mint,
            ctx.accounts.mint.key(),
            AapedError::InvalidVault
        );

        require!(
            ctx.accounts.launch_escrow.executed,
            AapedError::EscrowNotFunded
        );

        require!(
            !ctx.accounts.launch_escrow.refunded,
            AapedError::EscrowRefundUnavailable
        );

        require_keys_eq!(
        st.platform,
        PLATFORM_WALLET,
        AapedError::PlatformMismatch
        );

        require_keys_eq!(
        ctx.accounts.launch_fee_receiver.key(),
        LAUNCH_FEE_WALLET,
        AapedError::InvalidFeeReceiver
        );

        let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
        let launch_fee_ai = ctx.accounts.launch_fee_receiver.to_account_info();

        let rent_min = Rent::get()?.minimum_balance(0);
        let escrow_lamports = escrow_ai.lamports();
        let transferable = escrow_lamports.saturating_sub(rent_min);

        require!(transferable > 0, AapedError::InvalidAmount);

        let escrow_bump = st.escrow_sol_bump;

        let seeds: &[&[u8]] =
            &[b"escrow_sol", mint.as_ref(), &[escrow_bump]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: escrow_ai,
                    to: launch_fee_ai,
                },
                &[seeds],
            ),
            transferable,
        )?;

        st.escrow_settled = true;

        Ok(())
    }
    pub fn dev_buy_start_curve_from_escrow(
        ctx: Context<DevBuyStartCurveFromEscrow>,
        min_tokens_out: u64,
        ipfs_cid: String,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            AapedError::Unauthorized
        );

        require!(ipfs_cid.as_bytes().len() <= 120, AapedError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let launch_bump = ctx.accounts.launch_state.bump;
        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let launch_signer_seeds: &[&[u8]] = &[
            b"launch_state",
            mint.as_ref(),
            &[launch_bump],
        ];

        let st = &mut ctx.accounts.launch_state;
        let launch_escrow = &mut ctx.accounts.launch_escrow;

        require_keys_eq!(st.mint, ctx.accounts.mint.key(), AapedError::InvalidVault);
        require_keys_eq!(launch_escrow.mint, ctx.accounts.mint.key(), AapedError::InvalidVault);
        require_keys_eq!(launch_escrow.creator, st.creator, AapedError::InvalidEscrowCreator);
        require_keys_eq!(
            ctx.accounts.creator_receiver.key(),
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require!(!launch_escrow.executed, AapedError::EscrowAlreadyExecuted);
        require!(!launch_escrow.refunded, AapedError::EscrowRefundUnavailable);

        require!(
            st.state == LaunchPhase::PendingDevBuy as u8,
            AapedError::InvalidState
        );

        require!(!st.dev_buy_done, AapedError::InvalidState);

        let wsol_in = launch_escrow.dev_buy_lamports;
        require!(wsol_in > 0, AapedError::InvalidAmount);

        require_keys_eq!(
            ctx.accounts.sale_vault.mint,
            st.mint,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_ata.mint,
            st.mint,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            AapedError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_wsol_ata.owner,
            st.creator,
            AapedError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_WALLET,
            AapedError::PlatformMismatch
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            AapedError::InvalidVault
        );

        let sale_remaining: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(AapedError::MathOverflow)? as u128;

        require!(
            sale_remaining > 0,
            AapedError::InsufficientSaleLiquidity
        );

        require!(
            (min_tokens_out as u128) <= sale_remaining,
            AapedError::InsufficientSaleLiquidity
        );

        let wsol_in_u128: u128 = wsol_in as u128;

        let base_fee_max =
            bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let wsol_eff_max = wsol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(AapedError::MathOverflow)?;

        let (tokens_out_raw, _, _) =
            curve_buy(wsol_eff_max, st.sol_collected as u128, sale_remaining, 0)?;

        require!(tokens_out_raw > 0, AapedError::ZeroOutput);

        let (tokens_out, wsol_eff_used): (u128, u128) = if tokens_out_raw <= sale_remaining {
            (tokens_out_raw, wsol_eff_max)
        } else {
            let wsol_eff_needed = curve_sol_eff_for_exact_tokens_cp(
                sale_remaining,
                st.sol_collected as u128,
                sale_remaining,
            )?;

            (sale_remaining, wsol_eff_needed)
        };

        require!(
            tokens_out >= min_tokens_out as u128,
            AapedError::SlippageExceeded
        );

        let wsol_in_used =
            gross_from_net(wsol_eff_used, TRADE_FEE_TOTAL_BPS as u128)?;

        require!(wsol_in_used <= wsol_in_u128, AapedError::MathOverflow);

        let base_fee_used = wsol_in_used
            .checked_sub(wsol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        let (creator_fee, platform_fee) = split_bonding_fee(base_fee_used)?;

        let treasury_amount = wsol_eff_used;

        let required_lamports = creator_fee
            .checked_add(platform_fee)
            .ok_or(AapedError::MathOverflow)?
            .checked_add(treasury_amount)
            .ok_or(AapedError::MathOverflow)?;

        let unused_dev_buy = wsol_in_u128
            .checked_sub(wsol_in_used)
            .ok_or(AapedError::MathOverflow)?;

        let total_required_lamports = required_lamports
            .checked_add(unused_dev_buy)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            total_required_lamports <= ctx.accounts.escrow_sol_vault.to_account_info().lamports() as u128,
            AapedError::InsufficientTreasuryLiquidity
        );

        let escrow_seeds: &[&[u8]] = &[
            b"escrow_sol",
            mint.as_ref(),
            &[launch_escrow.escrow_sol_bump],
        ];

        if unused_dev_buy > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_sol_vault.to_account_info(),
                        to: ctx.accounts.creator_receiver.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                unused_dev_buy as u64,
            )?;
        }

        if creator_fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_sol_vault.to_account_info(),
                        to: ctx.accounts.creator_wsol_ata.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                creator_fee as u64,
            )?;

            sync_native_token_account(ctx.accounts.creator_wsol_ata.to_account_info())?;
        }

        if platform_fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_sol_vault.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                platform_fee as u64,
            )?;

            sync_native_token_account(ctx.accounts.platform_wsol_ata.to_account_info())?;
        }

        if treasury_amount > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_sol_vault.to_account_info(),
                        to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                treasury_amount as u64,
            )?;

            sync_native_token_account(ctx.accounts.treasury_wsol_vault.to_account_info())?;
        }

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.creator_ata.to_account_info(),
                    authority: launch_ai,
                },
                &[launch_signer_seeds],
            ),
            tokens_out as u64,
        )?;

        ctx.accounts.sale_vault.reload()?;
        ctx.accounts.treasury_wsol_vault.reload()?;
        ctx.accounts.creator_wsol_ata.reload()?;
        ctx.accounts.platform_wsol_ata.reload()?;

        st.tokens_sold = st
            .tokens_sold
            .checked_add(tokens_out as u64)
            .ok_or(AapedError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_add(wsol_eff_used)
            .ok_or(AapedError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        require!(st.tokens_sold <= st.sale_supply, AapedError::MathOverflow);

        st.dev_buy_done = true;
        st.state = LaunchPhase::Curve as u8;

        launch_escrow.executed = true;

        let curve_change_u128 = V_SOL
            .checked_add(wsol_in_used)
            .ok_or(AapedError::MathOverflow)?;

        require!(
            curve_change_u128 <= u64::MAX as u128,
            AapedError::MathOverflow
        );

        emit!(CreatedTxn {
            mint,
            ipfs_cid,
            devbuy: wsol_in_used as u64,
            curve_change: curve_change_u128 as u64,
        });

        Ok(())
    }

pub fn fund_launch_escrow(
    ctx: Context<FundLaunchEscrow>,
    dev_buy_lamports: u64,
) -> Result<()> {
    require!(dev_buy_lamports > 0, AapedError::InvalidAmount);

    require!(
        ctx.accounts.launch_escrow.to_account_info().lamports() == 0,
        AapedError::EscrowAlreadyFunded
    );

    let mint_key = ctx.accounts.mint.key();

    let total_deposit = CREATE_FEE_LAMPORTS
        .checked_add(dev_buy_lamports)
        .ok_or(AapedError::MathOverflow)?;

    create_pda_system_account(
        &ctx.accounts.creator,
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
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.escrow_sol_vault.to_account_info(),
            },
        ),
        total_deposit,
    )?;

    let escrow_seeds: &[&[u8]] = &[
        b"escrow_sol",
        mint_key.as_ref(),
        &[ctx.bumps.escrow_sol_vault],
    ];

    create_pda_account_from_escrow(
        &ctx.accounts.escrow_sol_vault,
        &ctx.accounts.launch_escrow,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
        LaunchEscrow::LEN,
        &crate::ID,
        &[
            b"launch_escrow",
            mint_key.as_ref(),
            &[ctx.bumps.launch_escrow],
        ],
        escrow_seeds,
    )?;

    let escrow_ai = ctx.accounts.launch_escrow.to_account_info();

    let mut launch_escrow: LaunchEscrow =
        LaunchEscrow::try_deserialize_unchecked(&mut &escrow_ai.data.borrow()[..])?;

    launch_escrow.bump = ctx.bumps.launch_escrow;
    launch_escrow.escrow_sol_bump = ctx.bumps.escrow_sol_vault;

    launch_escrow.creator = ctx.accounts.creator.key();
    launch_escrow.mint = mint_key;

    launch_escrow.create_fee_lamports = CREATE_FEE_LAMPORTS;
    launch_escrow.dev_buy_lamports = dev_buy_lamports;
    launch_escrow.deposited_lamports = total_deposit;

    launch_escrow.created_at = Clock::get()?.unix_timestamp;

    launch_escrow.executed = false;
    launch_escrow.refunded = false;

    let mut data = escrow_ai.data.borrow_mut();
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    launch_escrow.try_serialize(&mut cursor)?;

    emit!(LaunchEscrowFundedEvent {
        mint: mint_key,
        creator: ctx.accounts.creator.key(),
        create_fee_lamports: CREATE_FEE_LAMPORTS,
        dev_buy_lamports,
        deposited_lamports: total_deposit,
    });

    Ok(())
}

    pub fn refund_launch_escrow(ctx: Context<RefundLaunchEscrow>) -> Result<()> {
    let launch_escrow = &mut ctx.accounts.launch_escrow;

    require!(
        launch_escrow.creator == ctx.accounts.creator.key(),
        AapedError::InvalidEscrowCreator
    );

    require_keys_eq!(
        launch_escrow.mint,
        ctx.accounts.mint.key(),
        AapedError::InvalidVault
    );

    require!(!launch_escrow.executed, AapedError::EscrowAlreadyExecuted);
    require!(!launch_escrow.refunded, AapedError::EscrowRefundUnavailable);

    let now = Clock::get()?.unix_timestamp;

    let refund_available_at = launch_escrow
        .created_at
        .checked_add(LAUNCH_REFUND_TIMEOUT_SECONDS)
        .ok_or(AapedError::MathOverflow)?;

    require!(
        now >= refund_available_at,
        AapedError::EscrowTimeoutNotReached
    );

    let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
    let creator_ai = ctx.accounts.creator.to_account_info();

    let refundable_lamports = escrow_ai.lamports();

    require!(refundable_lamports > 0, AapedError::InvalidAmount);

    let mint_key = ctx.accounts.mint.key();
    let escrow_bump = launch_escrow.escrow_sol_bump;

    let escrow_seeds: &[&[u8]] = &[
        b"escrow_sol",
        mint_key.as_ref(),
        &[escrow_bump],
    ];

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: escrow_ai,
                to: creator_ai,
            },
            &[escrow_seeds],
        ),
        refundable_lamports,
    )?;

    launch_escrow.refunded = true;

    emit!(LaunchEscrowRefundedEvent {
        mint: mint_key,
        creator: ctx.accounts.creator.key(),
        refunded_lamports: refundable_lamports,
    });

    Ok(())
}

}

// -----------------------------
// helper functions
// -----------------------------

fn sync_native_token_account<'info>(token_account: AccountInfo<'info>) -> Result<()> {
    let ix = anchor_spl::token::spl_token::instruction::sync_native(
        &token::ID,
        &token_account.key(),
    )?;

    invoke(&ix, &[token_account])?;

    Ok(())
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
            escrow_signer_seeds,
            pda_seeds,
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
    #[account(mut)]
    pub platform_signer: Signer<'info>,

    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump
    )]
    pub launch_escrow: Account<'info, LaunchEscrow>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Account<'info, Mint>,

    #[account(address = USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"launch_state", mint.key().as_ref()], bump)]
    pub launch_state: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"sale_vault", mint.key().as_ref()], bump)]
    pub sale_vault: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"lp_vault", mint.key().as_ref()], bump)]
    pub lp_vault: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"treasury_wsol", mint.key().as_ref()], bump)]
    pub treasury_wsol_vault: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"treasury_usdc", mint.key().as_ref()], bump)]
    pub treasury_usdc_vault: UncheckedAccount<'info>,

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

    /// CHECK: static mint authority PDA
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

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

    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(metadata_bump: u8)]
pub struct FinalizeMintAuthorities<'info> {
    /// CHECK: static mint authority PDA
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

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
pub struct DevBuyStartCurveFromEscrow<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump
    )]
    pub launch_escrow: Account<'info, LaunchEscrow>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: native SOL escrow PDA.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_escrow.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    /// CHECK: receives any unused dev-buy SOL if the curve caps the first buy.
    #[account(mut, address = launch_state.creator)]
    pub creator_receiver: UncheckedAccount<'info>,

    #[account(mut, address = launch_state.sale_vault)]
    pub sale_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_wsol_ata.owner == launch_state.creator)]
    pub creator_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_wsol_ata.owner == PLATFORM_WALLET)]
    pub platform_wsol_ata: Account<'info, TokenAccount>,

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

    #[account(mut, constraint = buyer_wsol_ata.owner == buyer.key())]
    pub buyer_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_wsol_ata.owner == launch_state.creator)]
    pub creator_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_wsol_ata.owner == PLATFORM_WALLET)]
    pub platform_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
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

    #[account(mut, constraint = seller_wsol_ata.owner == seller.key())]
    pub seller_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_wsol_ata.owner == launch_state.creator)]
    pub creator_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_wsol_ata.owner == PLATFORM_WALLET)]
    pub platform_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: kept only for compatibility with the old claim flow
    #[account(mut)]
    pub creator_receiver: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BeginPoolSwitch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: platform receives fixed switch fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompletePoolSwitch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_usdc_vault)]
    pub treasury_usdc_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        close = launch_fee_receiver
    )]
    pub launch_escrow: Account<'info, LaunchEscrow>,

    /// CHECK: receives leftover escrow SOL after successful launch.
    #[account(mut, address = LAUNCH_FEE_WALLET)]
    pub launch_fee_receiver: UncheckedAccount<'info>,

    /// CHECK
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_state.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

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

    #[account(mut, constraint = buyer_wsol_ata.owner == buyer.key())]
    pub buyer_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_wsol_ata.owner == launch_state.creator)]
    pub creator_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_wsol_ata.owner == PLATFORM_WALLET)]
    pub platform_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
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

    #[account(mut, constraint = seller_wsol_ata.owner == seller.key())]
    pub seller_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_wsol_vault)]
    pub treasury_wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_wsol_ata.owner == launch_state.creator)]
    pub creator_wsol_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_wsol_ata.owner == PLATFORM_WALLET)]
    pub platform_wsol_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AmmBuyUsdcCtx<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = buyer_usdc_ata.owner == buyer.key())]
    pub buyer_usdc_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_usdc_vault)]
    pub treasury_usdc_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_usdc_ata.owner == launch_state.creator)]
    pub creator_usdc_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_usdc_ata.owner == PLATFORM_WALLET)]
    pub platform_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AmmSellUsdcCtx<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub launch_state: Account<'info, LaunchState>,

    #[account(mut, address = launch_state.lp_vault)]
    pub lp_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = seller_usdc_ata.owner == seller.key())]
    pub seller_usdc_ata: Account<'info, TokenAccount>,

    #[account(mut, address = launch_state.treasury_usdc_vault)]
    pub treasury_usdc_vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = creator_usdc_ata.owner == launch_state.creator)]
    pub creator_usdc_ata: Account<'info, TokenAccount>,

    #[account(mut, constraint = platform_usdc_ata.owner == PLATFORM_WALLET)]
    pub platform_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
 }

#[derive(Accounts)]
pub struct FundLaunchEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: mint address used for PDA derivation. It may be initialized later.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: launch escrow state PDA, created manually from escrow SOL.
    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump
    )]
    pub launch_escrow: UncheckedAccount<'info>,

    /// CHECK: native SOL escrow PDA.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RefundLaunchEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: mint address used for PDA derivation. It may be initialized later.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        close = creator
    )]
    pub launch_escrow: Account<'info, LaunchEscrow>,

    /// CHECK: native SOL escrow PDA.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_escrow.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
            }
