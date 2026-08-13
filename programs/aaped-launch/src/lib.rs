use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::{system_instruction, sysvar};
use anchor_lang::system_program;
use solana_security_txt::security_txt;
use solana_sha256_hasher::hashv;

use anchor_lang::{AccountDeserialize, AccountSerialize};

pub mod errors;
pub mod math;
pub mod state;

use crate::errors::MoonzError;
use crate::math::*;
use crate::state::*;

use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

use mpl_token_metadata;
use mpl_token_metadata::types::{Creator, DataV2};

declare_id!("DBc9SEQghiJUj52YPqTKk8R4CMRgagBxi2LU1yBbeMpk");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Moonz Launchpad",
    project_url: "https://moonz.fun",
    contacts: "link:https://github.com/detox267/aaped-launch/security/advisories/new",
    source_code: "https://github.com/detox267/aaped-launch",
    preferred_languages: "en",
    source_revision: "mainnet-v2"
}

// -------------------- CONSTANTS --------------------

/// Platform authority/admin signer.
/// Used only for platform-signed admin execution.
pub const PLATFORM_WALLET: Pubkey = pubkey!("BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL");

/// Platform fee receiver.
/// Receives platform WSOL/USDC trading fees and successful pool-switch fees.
/// This wallet does not need to sign program admin instructions.
pub const PLATFORM_FEE_WALLET: Pubkey = pubkey!("3mTCqBzGWMkUHqp3Ysepj3oewaMw6ndGQ368gEnxv1uH");

/// Separate launch-fee receiver.
/// Leftover escrow SOL after account setup settles here for IPFS/storage and operational costs.
pub const LAUNCH_FEE_WALLET: Pubkey = pubkey!("BzHkHtPHD51KJFAvDBUyAk9xJSjjgjEvbhhrdZGyLoSL");

/// Flat creator launch fee.
/// 0.04 SOL. This includes account setup/rent funding and storage/IPFS .
pub const CREATE_FEE_LAMPORTS: u64 = 40_000_000;

/// Refund timeout for failed launches.
/// If the platform/backend does not execute the launch, creator can refund after this delay.
pub const LAUNCH_REFUND_TIMEOUT_SECONDS: i64 = 300; // 5 minutes

fn require_launch_execution_allowed(
    created_at: i64,
    executed: bool,
    refunded: bool,
    now: i64,
) -> Result<()> {
    require!(!executed, MoonzError::EscrowAlreadyExecuted);
    require!(!refunded, MoonzError::EscrowRefundUnavailable);

    let deadline = created_at
        .checked_add(LAUNCH_REFUND_TIMEOUT_SECONDS)
        .ok_or(MoonzError::MathOverflow)?;

    require!(now < deadline, MoonzError::InvalidState);

    Ok(())
}

fn require_launch_refund_allowed(
    created_at: i64,
    executed: bool,
    refunded: bool,
    now: i64,
) -> Result<()> {
    require!(!executed, MoonzError::EscrowAlreadyExecuted);
    require!(!refunded, MoonzError::EscrowRefundUnavailable);

    let deadline = created_at
        .checked_add(LAUNCH_REFUND_TIMEOUT_SECONDS)
        .ok_or(MoonzError::MathOverflow)?;

    require!(
        now >= deadline,
        MoonzError::EscrowTimeoutNotReached
    );

    Ok(())
}

/// Mainnet WSOL mint.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// SPL Associated Token Account program. Used to force canonical fee vaults.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Canonical Circle USDC mint on Solana mainnet.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Static PDA seed for mint authority.
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";

/// Global creator fee authority PDA seed.
/// One PDA per creator wallet: [b"creator_fees", creator].
/// The PDA owns quote-token fee vault ATAs such as WSOL and USDC.
pub const CREATOR_FEES_SEED: &[u8] = b"creator_fees";

/// Quote asset selector.
/// Frontend can show WSOL mode as “SOL”.
pub const QUOTE_ASSET_WSOL: u8 = 0;
pub const QUOTE_ASSET_USDC: u8 = 1;

/// Pool quote-asset switch cooldown: 24 hours.
pub const POOL_SWITCH_COOLDOWN_SECONDS: i64 = 86_400;

/// Fixed pool switch fee: 0.5 SOL.
/// Creator pays this in native SOL when starting a switch.
pub const POOL_SWITCH_FEE_LAMPORTS: u64 = 500_000_000;

/// Minimum trade sizes stop dust-trade and rounding-abuse griefing.
pub const MIN_WSOL_TRADE_LAMPORTS: u64 = 10_000;
pub const MIN_USDC_TRADE_UNITS: u64 = 10_000;
pub const MIN_TOKEN_TRADE_UNITS: u64 = 1_000;

/// Launched Moonz tokens are fixed to 6 decimals.
/// The bonding curve math uses 6-decimal token base units, so this is enforced on-chain.
pub const LAUNCH_TOKEN_DECIMALS: u8 = 6;

/// Maximum Jupiter CPI remaining accounts allowed during pool switching.
/// Live mainnet instruction sizing was tested for WSOL/USDC and USDC/WSOL routes:
/// - WSOL -> USDC: 0.00005 WSOL through 100,000 WSOL
/// - USDC -> WSOL: 0.01 USDC through 10,000,000 USDC
/// Max observed: 53 remaining accounts, 22 writable accounts, 62 swap-data bytes, 3 route legs.
/// The protocol hard cap is 64 accounts. If a route cannot fit, the switch is aborted
/// and the creator's 0.5 SOL switch fee is returned.
pub const MAX_SWITCH_REMAINING_ACCOUNTS: usize = 64;

/// Max CPI swap instruction data length.
/// Observed Jupiter swap instruction data was under 64 bytes in sizing tests,
/// but this stays at 8 KiB to allow encoding variation while remaining transaction-bounded.
pub const MAX_SWITCH_SWAP_DATA_LEN: usize = 8_192;

/// Jupiter Aggregator v6 program.
/// Official Jupiter docs confirm this address as the program ID.
pub const JUPITER_V6_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Jupiter v6 ExactIn swap instruction discriminators.
/// Moonz deliberately permits only the two swap families used by the
/// production ExactIn pool-switch flow. Other Jupiter instructions must
/// never receive LaunchState PDA signing authority.
const JUPITER_ROUTE_DISCRIMINATOR: [u8; 8] =
    [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a];

const JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR: [u8; 8] =
    [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81];

/// How long a failed switch may remain in `Switching` before the creator can cancel.
pub const POOL_SWITCH_CANCEL_TIMEOUT_SECONDS: i64 = 1_800; // 30 minutes

/// Total trading fee: 1.25%.
pub const TRADE_FEE_TOTAL_BPS: u16 = 125;

/// Fee-share basis points use 10_000 = 100% of the fee.
/// Bonding fee split:
/// 30% platform
/// 70% creator
pub const BONDING_PLATFORM_SHARE_BPS: u16 = 3_000;
pub const BONDING_CREATOR_SHARE_BPS: u16 = 7_000;

/// AMM fee split:
/// 15% platform
/// 47.5% creator
/// 37.5% LP reserve
pub const AMM_PLATFORM_SHARE_BPS: u16 = 1_500;
pub const AMM_CREATOR_SHARE_BPS: u16 = 4_750;
pub const AMM_LP_SHARE_BPS: u16 = 3_750;

// -------------------- TOKENOMICS --------------------

pub const TOTAL_TOKENS: u64 = 1_000_000_000;
pub const SALE_TOKENS: u64 = 650_000_000;
pub const LP_TOKENS: u64 = 350_000_000;

/// HELPERS

fn pow10_u64(decimals: u8) -> Result<u64> {
    require!(decimals <= 18, MoonzError::InvalidAmount);

    let mut v: u64 = 1;
    for _ in 0..decimals {
        v = v.checked_mul(10).ok_or(MoonzError::MathOverflow)?;
    }

    Ok(v)
}

fn to_base_units(tokens: u64, decimals: u8) -> Result<u64> {
    let scale = pow10_u64(decimals)?;

    tokens
        .checked_mul(scale)
        .ok_or(MoonzError::MathOverflow.into())
}

fn valid_quote_asset(asset: u8) -> bool {
    asset == QUOTE_ASSET_WSOL || asset == QUOTE_ASSET_USDC
}

fn metadata_commitment(
    mint: Pubkey,
    creator: Pubkey,
    name: &str,
    symbol: &str,
    uri: &str,
) -> [u8; 32] {
    let name_len = (name.len() as u32).to_le_bytes();
    let symbol_len = (symbol.len() as u32).to_le_bytes();
    let uri_len = (uri.len() as u32).to_le_bytes();

    hashv(&[
        b"moonz_metadata_v1",
        mint.as_ref(),
        creator.as_ref(),
        &name_len,
        name.as_bytes(),
        &symbol_len,
        symbol.as_bytes(),
        &uri_len,
        uri.as_bytes(),
    ])
    .to_bytes()
}

fn expected_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            anchor_spl::token::ID.as_ref(),
            mint.as_ref(),
        ],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

fn require_canonical_ata(account: Pubkey, owner: Pubkey, mint: Pubkey) -> Result<()> {
    let expected = expected_ata(&owner, &mint);
    require_keys_eq!(account, expected, MoonzError::InvalidFeeReceiver);
    Ok(())
}

fn split_bonding_fee(total_fee: u128) -> Result<(u128, u128)> {
    let platform_fee = total_fee
        .checked_mul(BONDING_PLATFORM_SHARE_BPS as u128)
        .ok_or(MoonzError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MoonzError::MathOverflow)?;

    let creator_fee = total_fee
        .checked_sub(platform_fee)
        .ok_or(MoonzError::MathOverflow)?;

    Ok((creator_fee, platform_fee))
}

fn split_amm_fee(total_fee: u128) -> Result<(u128, u128, u128)> {
    require!(
        (AMM_PLATFORM_SHARE_BPS as u32)
            .checked_add(AMM_CREATOR_SHARE_BPS as u32)
            .ok_or(MoonzError::MathOverflow)?
            .checked_add(AMM_LP_SHARE_BPS as u32)
            .ok_or(MoonzError::MathOverflow)?
            == 10_000,
        MoonzError::FeeConfigInvalid
    );

    let platform_fee = total_fee
        .checked_mul(AMM_PLATFORM_SHARE_BPS as u128)
        .ok_or(MoonzError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MoonzError::MathOverflow)?;

    let creator_fee = total_fee
        .checked_mul(AMM_CREATOR_SHARE_BPS as u128)
        .ok_or(MoonzError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MoonzError::MathOverflow)?;

    let used = platform_fee
        .checked_add(creator_fee)
        .ok_or(MoonzError::MathOverflow)?;

    let lp_fee = total_fee
        .checked_sub(used)
        .ok_or(MoonzError::MathOverflow)?;

    Ok((lp_fee, creator_fee, platform_fee))
}

fn allowed_switch_swap_program(program_id: Pubkey) -> bool {
    program_id == JUPITER_V6_PROGRAM_ID
}

/// Verifies that a LaunchState account is the canonical PDA for its recorded mint.
/// This is intentionally checked at runtime as well as through account constraints where possible.
fn require_launch_state_pda(st: &LaunchState, account_key: Pubkey) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[b"launch_state", st.mint.as_ref()], &crate::ID);
    require_keys_eq!(account_key, expected, MoonzError::InvalidVault);
    Ok(())
}

/// Trading and AMM control is not reachable until metadata has been created
/// and mint/freeze authority have both been permanently removed.
fn require_launch_immutable_and_finalized(st: &LaunchState) -> Result<()> {
    require!(st.metadata_initialized, MoonzError::InvalidState);
    require!(st.mint_finalized, MoonzError::InvalidState);
    Ok(())
}

/// EVENTS
#[event]
pub struct PoolSwitchSwapExecutedEvent {
    pub mint: Pubkey,
    pub executor: Pubkey,
    pub from_asset: u8,
    pub to_asset: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    pub source_remaining: u64,
    pub destination_balance: u64,
}

#[event]
pub struct LaunchEscrowFundedEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub create_fee_lamports: u64,
    pub dev_buy_lamports: u64,
    pub dev_buy_min_tokens_out: u64,
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
    pub user: Pubkey,
    pub quote_asset: u8,
    pub input_amount: u64,
    pub input_mint: Pubkey,
    pub output_amount: u64,
    pub output_mint: Pubkey,
    pub quote_amount: u64,
    pub token_amount: u64,
    pub trade_fee: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub quote_collected_total: u64,
    pub timestamp: i64,
}

#[event]
pub struct SellEvent {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub quote_asset: u8,
    pub input_amount: u64,
    pub input_mint: Pubkey,
    pub output_amount: u64,
    pub output_mint: Pubkey,
    pub quote_amount: u64,
    pub token_amount: u64,
    pub trade_fee: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub quote_collected_total: u64,
    pub timestamp: i64,
}

#[event]
pub struct ClaimFeesEvent {
    pub creator: Pubkey,
    pub fee_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AmmBuyEvent {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub quote_asset: u8,
    pub input_amount: u64,
    pub input_mint: Pubkey,
    pub output_amount: u64,
    pub output_mint: Pubkey,
    pub quote_amount: u64,
    pub token_amount: u64,
    pub trade_fee: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub quote_collected_total: u64,
    pub timestamp: i64,
}

#[event]
pub struct AmmSellEvent {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub quote_asset: u8,
    pub input_amount: u64,
    pub input_mint: Pubkey,
    pub output_amount: u64,
    pub output_mint: Pubkey,
    pub quote_amount: u64,
    pub token_amount: u64,
    pub trade_fee: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub lp_fee: u64,
    pub tokens_sold_total: u64,
    pub quote_collected_total: u64,
    pub timestamp: i64,
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
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub switch_fee_lamports: u64,
}

#[event]
pub struct PoolSwitchCancelledEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub active_asset: u8,
    pub cancelled_at: i64,
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

    // TX0: user funds escrow PDA
    // Native SOL is only used here for account creation / rent funding.
    // Trading itself uses WSOL from the start.

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        params: InitializeParams,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            MoonzError::Unauthorized
        );

        require_keys_eq!(
            ctx.accounts.launch_escrow.creator,
            params.creator,
            MoonzError::InvalidEscrowCreator
        );

        require_keys_eq!(
            ctx.accounts.launch_escrow.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );

        require!(
            !ctx.accounts.launch_escrow.executed,
            MoonzError::EscrowAlreadyExecuted
        );

        require!(
            !ctx.accounts.launch_escrow.refunded,
            MoonzError::EscrowRefundUnavailable
        );

        let now = Clock::get()?.unix_timestamp;

        require_launch_execution_allowed(
            ctx.accounts.launch_escrow.created_at,
            ctx.accounts.launch_escrow.executed,
            ctx.accounts.launch_escrow.refunded,
            now,
        )?;

        require!(
            ctx.accounts.launch_escrow.deposited_lamports
                >= ctx
                    .accounts
                    .launch_escrow
                    .create_fee_lamports
                    .checked_add(ctx.accounts.launch_escrow.dev_buy_lamports)
                    .ok_or(MoonzError::MathOverflow)?,
            MoonzError::EscrowNotFunded
        );

        require_keys_eq!(
            ctx.accounts.wsol_mint.key(),
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            USDC_MINT,
            MoonzError::InvalidVault
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            MoonzError::Unauthorized
        );

        let mint_auth = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(MoonzError::Unauthorized)?;

        require_keys_eq!(mint_auth, expected_mint_authority, MoonzError::Unauthorized);

        let freeze_auth = ctx
            .accounts
            .mint
            .freeze_authority
            .ok_or(MoonzError::Unauthorized)?;

        require_keys_eq!(
            freeze_auth,
            expected_mint_authority,
            MoonzError::Unauthorized
        );

        require!(ctx.accounts.mint.supply == 0, MoonzError::InvalidAmount);

        require!(
            ctx.accounts.mint.decimals == LAUNCH_TOKEN_DECIMALS,
            MoonzError::InvalidAmount
        );

        require!(
            params.name.as_bytes().len() <= 32,
            MoonzError::InvalidAmount
        );
        require!(
            params.symbol.as_bytes().len() <= 10,
            MoonzError::InvalidAmount
        );
        require!(
            params.uri.as_bytes().len() <= 200,
            MoonzError::InvalidAmount
        );

        let mint_key = ctx.accounts.mint.key();
        let expected_metadata_commitment = metadata_commitment(
            mint_key,
            params.creator,
            &params.name,
            &params.symbol,
            &params.uri,
        );

        require!(
            ctx.accounts.launch_escrow.metadata_commitment == expected_metadata_commitment,
            MoonzError::MetadataCommitmentMismatch
        );
        let decimals = ctx.accounts.mint.decimals;

        let total_supply_locked = to_base_units(TOTAL_TOKENS, decimals)?;
        let sale_supply_locked = to_base_units(SALE_TOKENS, decimals)?;
        let lp_supply_locked = to_base_units(LP_TOKENS, decimals)?;

        require!(
            sale_supply_locked
                .checked_add(lp_supply_locked)
                .ok_or(MoonzError::MathOverflow)?
                == total_supply_locked,
            MoonzError::MathOverflow
        );

        require!(
            ctx.accounts.escrow_sol_vault.lamports() >= Rent::get()?.minimum_balance(0),
            MoonzError::InsufficientTreasuryLiquidity
        );

        let escrow_bump = ctx.bumps.escrow_sol_vault;

        let escrow_seeds: &[&[u8]] = &[b"escrow_sol", mint_key.as_ref(), &[escrow_bump]];

        // initialize_launch is one-time for a mint.
        // PDA creation below safely handles dust-prefunded, system-owned, zero-data PDAs
        // by topping up rent, allocating space, and assigning ownership. Already initialized
        // PDAs owned by the target program are rejected unless they exactly match the
        // expected owner and size.

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
            &[b"sale_vault", mint_key.as_ref(), &[ctx.bumps.sale_vault]],
            escrow_seeds,
        )?;

        create_pda_account_from_escrow(
            &ctx.accounts.escrow_sol_vault,
            &ctx.accounts.lp_vault,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            anchor_spl::token::TokenAccount::LEN,
            &ctx.accounts.token_program.key(),
            &[b"lp_vault", mint_key.as_ref(), &[ctx.bumps.lp_vault]],
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

        require!(
            ctx.accounts.escrow_sol_vault.lamports() >= ctx.accounts.launch_escrow.dev_buy_lamports,
            MoonzError::InsufficientTreasuryLiquidity
        );

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
        st.escrow_sol_bump = ctx.bumps.escrow_sol_vault;

        st.state = LaunchPhase::PendingDevBuy as u8;

        st.mint = mint_key;
        st.creator = params.creator;
        st.metadata_commitment = expected_metadata_commitment;

        st.sale_supply = sale_supply_locked;

        st.quote_asset = QUOTE_ASSET_WSOL;
        st.pending_quote_asset = QUOTE_ASSET_WSOL;
        st.last_pool_switch_ts = 0;
        st.switch_started_at = 0;
        st.switch_fee_escrowed_lamports = 0;
        st.switch_amount_in = 0;
        st.switch_min_amount_out = 0;
        st.switch_swap_executed = false;

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
        st.metadata_initialized = false;
        st.mint_finalized = false;

        let now = Clock::get()?.unix_timestamp;
        st.last_trade_ts = now;

        let mut data = launch_ai.data.borrow_mut();
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        st.try_serialize(&mut cursor)?;

        let mint_auth_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[mint_auth_bump]];

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

        ctx.accounts.launch_escrow.initialized = true;

        Ok(())
    }

    pub fn initialize_metadata(
        ctx: Context<InitializeMetadata>,
        _metadata_bump: u8,
        params: MetadataParams,
    ) -> Result<()> {
        let st = &mut ctx.accounts.launch_state;

        require!(
            st.state == LaunchPhase::PendingDevBuy as u8,
            MoonzError::InvalidState
        );
        require!(!st.metadata_initialized, MoonzError::InvalidState);
        require!(!st.mint_finalized, MoonzError::InvalidState);

        let now = Clock::get()?.unix_timestamp;

        require_launch_execution_allowed(
            ctx.accounts.launch_escrow.created_at,
            ctx.accounts.launch_escrow.executed,
            ctx.accounts.launch_escrow.refunded,
            now,
        )?;

        require_keys_eq!(st.mint, ctx.accounts.mint.key(), MoonzError::InvalidVault);

        require_keys_eq!(
            st.metadata,
            ctx.accounts.metadata.key(),
            MoonzError::InvalidVault
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            MoonzError::Unauthorized
        );

        let mint_auth = ctx
            .accounts
            .mint
            .mint_authority
            .ok_or(MoonzError::Unauthorized)?;

        require_keys_eq!(mint_auth, expected_mint_authority, MoonzError::Unauthorized);

        require!(
            params.name.as_bytes().len() <= 32,
            MoonzError::InvalidAmount
        );
        require!(
            params.symbol.as_bytes().len() <= 10,
            MoonzError::InvalidAmount
        );
        require!(
            params.uri.as_bytes().len() <= 200,
            MoonzError::InvalidAmount
        );

        require!(
            st.metadata_commitment
                == metadata_commitment(
                    st.mint,
                    st.creator,
                    &params.name,
                    &params.symbol,
                    &params.uri,
                ),
            MoonzError::MetadataCommitmentMismatch
        );

        use mpl_token_metadata::instructions::{
            CreateMetadataAccountV3, CreateMetadataAccountV3InstructionArgs,
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

        let mint_auth_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[mint_auth_bump]];

        invoke_signed(
            &create_ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.mint_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.token_metadata_program.to_account_info(),
            ],
            &[mint_auth_seeds],
        )?;

        st.metadata_initialized = true;

        Ok(())
    }

    pub fn finalize_mint_authorities(
        ctx: Context<FinalizeMintAuthorities>,
        _metadata_bump: u8,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            MoonzError::Unauthorized
        );

        require!(
            ctx.accounts.launch_state.state == LaunchPhase::PendingDevBuy as u8,
            MoonzError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.launch_state.metadata,
            ctx.accounts.metadata.key(),
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.launch_state.metadata_initialized,
            MoonzError::InvalidState
        );

        require!(
            !ctx.accounts.launch_state.mint_finalized,
            MoonzError::InvalidState
        );

        let now = Clock::get()?.unix_timestamp;

        require_launch_execution_allowed(
            ctx.accounts.launch_escrow.created_at,
            ctx.accounts.launch_escrow.executed,
            ctx.accounts.launch_escrow.refunded,
            now,
        )?;

        require_keys_eq!(
            *ctx.accounts.metadata.to_account_info().owner,
            mpl_token_metadata::ID,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.metadata.to_account_info().data_len() > 0,
            MoonzError::InvalidVault
        );

        let expected_total_supply = to_base_units(TOTAL_TOKENS, ctx.accounts.mint.decimals)?;
        require!(
            ctx.accounts.mint.supply == expected_total_supply,
            MoonzError::InvalidAmount
        );

        let (expected_mint_authority, mint_auth_bump) =
            Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &crate::ID);

        require_keys_eq!(
            ctx.accounts.mint_authority.key(),
            expected_mint_authority,
            MoonzError::Unauthorized
        );

        let mint_auth_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[mint_auth_bump]];

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

        ctx.accounts.launch_state.mint_finalized = true;

        Ok(())
    }

    // Bonding curve - WSOL quote

    pub fn buy(ctx: Context<Buy>, wsol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(
            wsol_in >= MIN_WSOL_TRADE_LAMPORTS,
            MoonzError::InvalidAmount
        );
        require!(min_tokens_out > 0, MoonzError::InvalidAmount);

        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::Curve as u8 || st.state == LaunchPhase::AmmLive as u8,
            MoonzError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.buyer_wsol_ata.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_FEE_WALLET,
            MoonzError::PlatformMismatch
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_wsol_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            WSOL_MINT,
        )?;

        require_canonical_ata(
            ctx.accounts.platform_wsol_ata.key(),
            PLATFORM_FEE_WALLET,
            WSOL_MINT,
        )?;

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.lp_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        let mint = st.mint;
        let bump = st.bump;

        let signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

        if st.state == LaunchPhase::AmmLive as u8 {
            require!(st.quote_asset == QUOTE_ASSET_WSOL, MoonzError::InvalidState);

            let wsol_in_u128 = wsol_in as u128;

            let quote_reserve = ctx.accounts.treasury_wsol_vault.amount as u128;
            let tok_reserve = ctx.accounts.lp_vault.amount as u128;

            require!(quote_reserve > 0, MoonzError::InsufficientTreasuryLiquidity);
            require!(tok_reserve > 0, MoonzError::InsufficientSaleLiquidity);

            let total_fee = bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

            let wsol_trade = wsol_in_u128
                .checked_sub(total_fee)
                .ok_or(MoonzError::MathOverflow)?;

            let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fee)?;

            let tokens_out = amm_buy_tokens_out(wsol_trade, quote_reserve, tok_reserve)?;

            require!(tokens_out > 0, MoonzError::ZeroOutput);

            require!(
                tokens_out >= min_tokens_out as u128,
                MoonzError::SlippageExceeded
            );

            let wsol_to_pool = wsol_trade
                .checked_add(lp_fee)
                .ok_or(MoonzError::MathOverflow)?;

            if wsol_to_pool > 0 {
                token::transfer(
                    CpiContext::new(
                        token_program_ai.clone(),
                        Transfer {
                            from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                            to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                            authority: ctx.accounts.buyer.to_account_info(),
                        },
                    ),
                    wsol_to_pool as u64,
                )?;
            }

            if creator_fee > 0 {
                token::transfer(
                    CpiContext::new(
                        token_program_ai.clone(),
                        Transfer {
                            from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                            to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
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

            token::transfer(
                CpiContext::new_with_signer(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.lp_vault.to_account_info(),
                        to: ctx.accounts.buyer_ata.to_account_info(),
                        authority: launch_ai.clone(),
                    },
                    &[signer_seeds],
                ),
                tokens_out as u64,
            )?;

            st.last_trade_ts = Clock::get()?.unix_timestamp;

            emit!(AmmBuyEvent {
                mint,
                user: ctx.accounts.buyer.key(),
                quote_asset: QUOTE_ASSET_WSOL,
                input_amount: wsol_in,
                input_mint: WSOL_MINT,
                output_amount: tokens_out as u64,
                output_mint: mint,
                quote_amount: wsol_in,
                token_amount: tokens_out as u64,
                trade_fee: total_fee as u64,
                creator_fee: creator_fee as u64,
                platform_fee: platform_fee as u64,
                lp_fee: lp_fee as u64,
                tokens_sold_total: st.tokens_sold,
                quote_collected_total: quote_reserve
                    .checked_add(wsol_to_pool)
                    .ok_or(MoonzError::MathOverflow)? as u64,
                timestamp: st.last_trade_ts,
            });

            return Ok(());
        }

        let sale_remaining: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(MoonzError::MathOverflow)? as u128;

        require!(sale_remaining > 0, MoonzError::InsufficientSaleLiquidity);

        let wsol_in_u128: u128 = wsol_in as u128;

        let base_fee_max = bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let wsol_eff_max = wsol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(MoonzError::MathOverflow)?;

        let (tokens_out_raw, _, _) =
            curve_buy(wsol_eff_max, st.sol_collected as u128, sale_remaining, 0)?;

        require!(tokens_out_raw > 0, MoonzError::ZeroOutput);

        let overbuy = tokens_out_raw > sale_remaining;

        let (bonding_tokens_out, bonding_wsol_eff_used): (u128, u128) = if !overbuy {
            (tokens_out_raw, wsol_eff_max)
        } else {
            let wsol_eff_needed = curve_sol_eff_for_exact_tokens_cp(
                sale_remaining,
                st.sol_collected as u128,
                sale_remaining,
            )?;

            (sale_remaining, wsol_eff_needed)
        };

        let bonding_wsol_gross_used = if !overbuy {
            // For normal buys, use the original gross input.
            wsol_in_u128
        } else {
            gross_from_net(bonding_wsol_eff_used, TRADE_FEE_TOTAL_BPS as u128)?
        };

        require!(
            bonding_wsol_gross_used <= wsol_in_u128,
            MoonzError::MathOverflow
        );

        let bonding_fee_used = if !overbuy {
            base_fee_max
        } else {
            bonding_wsol_gross_used
                .checked_sub(bonding_wsol_eff_used)
                .ok_or(MoonzError::MathOverflow)?
        };

        let (bonding_creator_fee, bonding_platform_fee) = split_bonding_fee(bonding_fee_used)?;

        let bonding_treasury_amount = bonding_wsol_eff_used;

        if bonding_creator_fee > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                bonding_creator_fee as u64,
            )?;
        }

        if bonding_platform_fee > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.platform_wsol_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                bonding_platform_fee as u64,
            )?;
        }

        if bonding_treasury_amount > 0 {
            token::transfer(
                CpiContext::new(
                    token_program_ai.clone(),
                    Transfer {
                        from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                        to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                bonding_treasury_amount as u64,
            )?;
        }

        token::transfer(
            CpiContext::new_with_signer(
                token_program_ai.clone(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: launch_ai.clone(),
                },
                &[signer_seeds],
            ),
            bonding_tokens_out as u64,
        )?;

        ctx.accounts.sale_vault.reload()?;
        ctx.accounts.treasury_wsol_vault.reload()?;
        ctx.accounts.lp_vault.reload()?;

        st.tokens_sold = st
            .tokens_sold
            .checked_add(bonding_tokens_out as u64)
            .ok_or(MoonzError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_add(bonding_wsol_eff_used)
            .ok_or(MoonzError::MathOverflow)?;

        require!(st.tokens_sold <= st.sale_supply, MoonzError::MathOverflow);

        let mut total_tokens_out = bonding_tokens_out;
        let mut amm_wsol_gross_used_total: u128 = 0;
        let mut amm_fee_used_total: u128 = 0;
        let mut amm_lp_fee_used_total: u128 = 0;
        let mut amm_creator_fee_used_total: u128 = 0;
        let mut amm_platform_fee_used_total: u128 = 0;

        if st.tokens_sold == st.sale_supply {
            // Direct token transfers into the sale vault must not be able to block migration.
            // Once the configured sale supply has been sold, move any donated remainder into
            // the AMM token reserve before enabling AMM trading.
            let donated_sale_tokens = ctx.accounts.sale_vault.amount;

            if donated_sale_tokens > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_ai.clone(),
                        Transfer {
                            from: ctx.accounts.sale_vault.to_account_info(),
                            to: ctx.accounts.lp_vault.to_account_info(),
                            authority: launch_ai.clone(),
                        },
                        &[signer_seeds],
                    ),
                    donated_sale_tokens,
                )?;

                ctx.accounts.sale_vault.reload()?;
                ctx.accounts.lp_vault.reload()?;
            }

            require!(
                ctx.accounts.sale_vault.amount == 0,
                MoonzError::InvalidState
            );

            require!(
                ctx.accounts.treasury_wsol_vault.amount > 0,
                MoonzError::InsufficientTreasuryLiquidity
            );

            require!(
                ctx.accounts.lp_vault.amount > 0,
                MoonzError::InsufficientSaleLiquidity
            );

            st.quote_asset = QUOTE_ASSET_WSOL;
            st.pending_quote_asset = QUOTE_ASSET_WSOL;

            st.state = LaunchPhase::AmmLive as u8;

            emit!(MigratedEvent { mint: st.mint });

            let leftover_wsol_gross = wsol_in_u128
                .checked_sub(bonding_wsol_gross_used)
                .ok_or(MoonzError::MathOverflow)?;

            if leftover_wsol_gross > 0 {
                let amm_total_fee = bps_amount(leftover_wsol_gross, TRADE_FEE_TOTAL_BPS as u128)?;

                let amm_wsol_trade = leftover_wsol_gross
                    .checked_sub(amm_total_fee)
                    .ok_or(MoonzError::MathOverflow)?;

                let (amm_lp_fee, amm_creator_fee, amm_platform_fee) = split_amm_fee(amm_total_fee)?;

                amm_wsol_gross_used_total = leftover_wsol_gross;
                amm_fee_used_total = amm_total_fee;
                amm_lp_fee_used_total = amm_lp_fee;
                amm_creator_fee_used_total = amm_creator_fee;
                amm_platform_fee_used_total = amm_platform_fee;

                let quote_reserve = ctx.accounts.treasury_wsol_vault.amount as u128;
                let tok_reserve = ctx.accounts.lp_vault.amount as u128;

                require!(quote_reserve > 0, MoonzError::InsufficientTreasuryLiquidity);
                require!(tok_reserve > 0, MoonzError::InsufficientSaleLiquidity);

                let amm_tokens_out =
                    amm_buy_tokens_out(amm_wsol_trade, quote_reserve, tok_reserve)?;

                require!(amm_tokens_out > 0, MoonzError::ZeroOutput);

                let wsol_to_pool = amm_wsol_trade
                    .checked_add(amm_lp_fee)
                    .ok_or(MoonzError::MathOverflow)?;

                if wsol_to_pool > 0 {
                    token::transfer(
                        CpiContext::new(
                            token_program_ai.clone(),
                            Transfer {
                                from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                                to: ctx.accounts.treasury_wsol_vault.to_account_info(),
                                authority: ctx.accounts.buyer.to_account_info(),
                            },
                        ),
                        wsol_to_pool as u64,
                    )?;
                }

                if amm_creator_fee > 0 {
                    token::transfer(
                        CpiContext::new(
                            token_program_ai.clone(),
                            Transfer {
                                from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                                to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                                authority: ctx.accounts.buyer.to_account_info(),
                            },
                        ),
                        amm_creator_fee as u64,
                    )?;
                }

                if amm_platform_fee > 0 {
                    token::transfer(
                        CpiContext::new(
                            token_program_ai.clone(),
                            Transfer {
                                from: ctx.accounts.buyer_wsol_ata.to_account_info(),
                                to: ctx.accounts.platform_wsol_ata.to_account_info(),
                                authority: ctx.accounts.buyer.to_account_info(),
                            },
                        ),
                        amm_platform_fee as u64,
                    )?;
                }

                token::transfer(
                    CpiContext::new_with_signer(
                        token_program_ai.clone(),
                        Transfer {
                            from: ctx.accounts.lp_vault.to_account_info(),
                            to: ctx.accounts.buyer_ata.to_account_info(),
                            authority: launch_ai.clone(),
                        },
                        &[signer_seeds],
                    ),
                    amm_tokens_out as u64,
                )?;

                total_tokens_out = total_tokens_out
                    .checked_add(amm_tokens_out)
                    .ok_or(MoonzError::MathOverflow)?;
            }
        }

        require!(
            total_tokens_out >= min_tokens_out as u128,
            MoonzError::SlippageExceeded
        );

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        let total_trade_fee = bonding_fee_used
            .checked_add(amm_fee_used_total)
            .ok_or(MoonzError::MathOverflow)?;

        let total_creator_fee = bonding_creator_fee
            .checked_add(amm_creator_fee_used_total)
            .ok_or(MoonzError::MathOverflow)?;

        let total_platform_fee = bonding_platform_fee
            .checked_add(amm_platform_fee_used_total)
            .ok_or(MoonzError::MathOverflow)?;

        let quote_amount_used = bonding_wsol_gross_used
            .checked_add(amm_wsol_gross_used_total)
            .ok_or(MoonzError::MathOverflow)?;

        let quote_collected_total = if st.state == LaunchPhase::AmmLive as u8 {
            ctx.accounts.treasury_wsol_vault.reload()?;
            ctx.accounts.treasury_wsol_vault.amount
        } else {
            st.sol_collected as u64
        };

        emit!(BuyEvent {
            mint,
            user: ctx.accounts.buyer.key(),
            quote_asset: QUOTE_ASSET_WSOL,
            input_amount: wsol_in,
            input_mint: WSOL_MINT,
            output_amount: total_tokens_out as u64,
            output_mint: mint,
            quote_amount: quote_amount_used as u64,
            token_amount: total_tokens_out as u64,
            trade_fee: total_trade_fee as u64,
            creator_fee: total_creator_fee as u64,
            platform_fee: total_platform_fee as u64,
            lp_fee: amm_lp_fee_used_total as u64,
            tokens_sold_total: st.tokens_sold,
            quote_collected_total,
            timestamp: st.last_trade_ts,
        });

        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_wsol_out: u64) -> Result<()> {
        require!(
            tokens_in >= MIN_TOKEN_TRADE_UNITS,
            MoonzError::InvalidAmount
        );
        require!(min_wsol_out > 0, MoonzError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let launch_bump = ctx.accounts.launch_state.bump;
        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let launch_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[launch_bump]];

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::Curve as u8 || st.state == LaunchPhase::AmmLive as u8,
            MoonzError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.seller_wsol_ata.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_FEE_WALLET,
            MoonzError::PlatformMismatch
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_wsol_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            WSOL_MINT,
        )?;

        require_canonical_ata(
            ctx.accounts.platform_wsol_ata.key(),
            PLATFORM_FEE_WALLET,
            WSOL_MINT,
        )?;

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.seller_ata.amount >= tokens_in,
            MoonzError::InsufficientSaleLiquidity
        );

        if st.state == LaunchPhase::AmmLive as u8 {
            require!(st.quote_asset == QUOTE_ASSET_WSOL, MoonzError::InvalidState);

            let quote_reserve = ctx.accounts.treasury_wsol_vault.amount as u128;
            let tok_reserve = ctx.accounts.lp_vault.amount as u128;

            require!(quote_reserve > 0, MoonzError::InsufficientTreasuryLiquidity);
            require!(tok_reserve > 0, MoonzError::InsufficientSaleLiquidity);

            let sol_gross = amm_sell_sol_out_gross(tokens_in as u128, quote_reserve, tok_reserve)?;

            require!(sol_gross > 0, MoonzError::ZeroOutput);

            let total_fee = bps_amount(sol_gross, TRADE_FEE_TOTAL_BPS as u128)?;

            let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fee)?;

            let wsol_net = sol_gross
                .checked_sub(total_fee)
                .ok_or(MoonzError::MathOverflow)?;

            require!(
                wsol_net >= min_wsol_out as u128,
                MoonzError::SlippageExceeded
            );

            let treasury_out = wsol_net
                .checked_add(creator_fee)
                .ok_or(MoonzError::MathOverflow)?
                .checked_add(platform_fee)
                .ok_or(MoonzError::MathOverflow)?;

            require!(
                quote_reserve >= treasury_out,
                MoonzError::InsufficientTreasuryLiquidity
            );

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

            if wsol_net > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.treasury_wsol_vault.to_account_info(),
                            to: ctx.accounts.seller_wsol_ata.to_account_info(),
                            authority: launch_ai.clone(),
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
                            to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                            authority: launch_ai.clone(),
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
                            authority: launch_ai.clone(),
                        },
                        &[launch_seeds],
                    ),
                    platform_fee as u64,
                )?;
            }

            st.last_trade_ts = Clock::get()?.unix_timestamp;

            emit!(AmmSellEvent {
                mint,
                user: ctx.accounts.seller.key(),
                quote_asset: QUOTE_ASSET_WSOL,
                input_amount: tokens_in,
                input_mint: mint,
                output_amount: wsol_net as u64,
                output_mint: WSOL_MINT,
                quote_amount: sol_gross as u64,
                token_amount: tokens_in,
                trade_fee: total_fee as u64,
                creator_fee: creator_fee as u64,
                platform_fee: platform_fee as u64,
                lp_fee: lp_fee as u64,
                tokens_sold_total: st.tokens_sold,
                quote_collected_total: quote_reserve
                    .checked_sub(treasury_out)
                    .ok_or(MoonzError::MathOverflow)? as u64,
                timestamp: st.last_trade_ts,
            });

            return Ok(());
        }

        let wsol_real: u128 = ctx.accounts.treasury_wsol_vault.amount as u128;
        let state_wsol_real: u128 = st.sol_collected as u128;

        require!(
            tokens_in <= st.tokens_sold,
            MoonzError::InsufficientSaleLiquidity
        );

        let tok_real: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(MoonzError::MathOverflow)? as u128;

        let wsol_gross = curve_sell_gross(tokens_in as u128, state_wsol_real, tok_real)?;

        require!(wsol_gross > 0, MoonzError::ZeroOutput);

        // Price from tracked bonding reserves. Direct WSOL donations must not alter
        // the curve or block sells; the actual vault balance is only a solvency check.
        require!(
            wsol_real >= wsol_gross,
            MoonzError::InsufficientTreasuryLiquidity
        );

        let base_fee: u128 = bps_amount(wsol_gross, TRADE_FEE_TOTAL_BPS as u128)?;

        let (creator_fee, platform_fee) = split_bonding_fee(base_fee)?;

        let wsol_net: u128 = wsol_gross
            .checked_sub(base_fee)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            wsol_net >= min_wsol_out as u128,
            MoonzError::SlippageExceeded
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
                        authority: launch_ai.clone(),
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
                        to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                        authority: launch_ai.clone(),
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
                        authority: launch_ai.clone(),
                    },
                    &[launch_seeds],
                ),
                platform_fee as u64,
            )?;
        }

        st.tokens_sold = st
            .tokens_sold
            .checked_sub(tokens_in)
            .ok_or(MoonzError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_sub(wsol_gross)
            .ok_or(MoonzError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(SellEvent {
            mint,
            user: ctx.accounts.seller.key(),
            quote_asset: QUOTE_ASSET_WSOL,
            input_amount: tokens_in,
            input_mint: mint,
            output_amount: wsol_net as u64,
            output_mint: WSOL_MINT,
            quote_amount: wsol_gross as u64,
            token_amount: tokens_in,
            trade_fee: base_fee as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: 0,
            tokens_sold_total: st.tokens_sold,
            quote_collected_total: st.sol_collected as u64,
            timestamp: st.last_trade_ts,
        });

        Ok(())
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.creator_fee_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.creator_receiver_ata.owner,
            ctx.accounts.creator.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_vault.mint,
            ctx.accounts.creator_receiver_ata.mint,
            MoonzError::InvalidVault
        );

        let fee_mint = ctx.accounts.creator_fee_vault.mint;

        require!(
            fee_mint == WSOL_MINT || fee_mint == USDC_MINT,
            MoonzError::InvalidVault
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            fee_mint,
        )?;

        require_canonical_ata(
            ctx.accounts.creator_receiver_ata.key(),
            ctx.accounts.creator.key(),
            fee_mint,
        )?;

        let amount = ctx.accounts.creator_fee_vault.amount;

        require!(amount > 0, MoonzError::InvalidAmount);

        let creator_key = ctx.accounts.creator.key();
        let signer_seeds: &[&[u8]] = &[
            CREATOR_FEES_SEED,
            creator_key.as_ref(),
            &[ctx.bumps.creator_fee_authority],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.creator_fee_vault.to_account_info(),
                    to: ctx.accounts.creator_receiver_ata.to_account_info(),
                    authority: ctx.accounts.creator_fee_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        emit!(ClaimFeesEvent {
            creator: ctx.accounts.creator.key(),
            fee_mint,
            amount,
        });

        Ok(())
    }

    /// Pool quote-asset switch control

    pub fn begin_pool_switch(
        ctx: Context<BeginPoolSwitch>,
        target_quote_asset: u8,
        expected_pool_amount: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        require!(
            valid_quote_asset(target_quote_asset),
            MoonzError::InvalidAmount
        );

        require!(expected_pool_amount > 0, MoonzError::InvalidAmount);
        require!(min_amount_out > 0, MoonzError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let launch_state_key = ctx.accounts.launch_state.key();

        let st = &mut ctx.accounts.launch_state;

        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            MoonzError::InvalidState
        );

        require_keys_eq!(
            ctx.accounts.creator.key(),
            st.creator,
            MoonzError::Unauthorized
        );

        require!(
            target_quote_asset != st.quote_asset,
            MoonzError::InvalidState
        );

        require!(
            st.switch_fee_escrowed_lamports == 0,
            MoonzError::InvalidState
        );

        require!(st.switch_amount_in == 0, MoonzError::InvalidState);

        require!(st.switch_min_amount_out == 0, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.source_quote_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        if st.quote_asset == QUOTE_ASSET_WSOL {
            require_keys_eq!(
                ctx.accounts.source_quote_vault.key(),
                st.treasury_wsol_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.source_quote_vault.mint,
                WSOL_MINT,
                MoonzError::InvalidVault
            );
        } else if st.quote_asset == QUOTE_ASSET_USDC {
            require_keys_eq!(
                ctx.accounts.source_quote_vault.key(),
                st.treasury_usdc_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.source_quote_vault.mint,
                USDC_MINT,
                MoonzError::InvalidVault
            );
        } else {
            return err!(MoonzError::InvalidState);
        }

        // The complete active quote reserve is selected automatically.
        // The creator cannot choose a partial amount.
        let amount_in = ctx.accounts.source_quote_vault.amount;

        require!(amount_in > 0, MoonzError::InsufficientTreasuryLiquidity);

        // The creator signs the exact full-pool amount shown during review.
        // If trading changes the vault before confirmation, this transaction
        // fails and the creator must review a fresh amount.
        require!(
            amount_in == expected_pool_amount,
            MoonzError::PoolBalanceChanged
        );

        if st.last_pool_switch_ts > 0 {
            let elapsed = now
                .checked_sub(st.last_pool_switch_ts)
                .ok_or(MoonzError::MathOverflow)?;

            require!(
                elapsed >= POOL_SWITCH_COOLDOWN_SECONDS,
                MoonzError::SwitchCooldownActive
            );
        }

        let switch_fee_ix = system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &st.key(),
            POOL_SWITCH_FEE_LAMPORTS,
        );

        invoke(
            &switch_fee_ix,
            &[
                ctx.accounts.creator.to_account_info(),
                st.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        st.switch_fee_escrowed_lamports = POOL_SWITCH_FEE_LAMPORTS;
        st.switch_amount_in = amount_in;
        st.switch_min_amount_out = min_amount_out;
        st.switch_swap_executed = false;
        st.pending_quote_asset = target_quote_asset;
        st.switch_started_at = now;
        st.state = LaunchPhase::Switching as u8;

        emit!(PoolSwitchStartedEvent {
            mint: st.mint,
            creator: st.creator,
            from_asset: st.quote_asset,
            to_asset: target_quote_asset,
            amount_in,
            min_amount_out,
            switch_fee_lamports: POOL_SWITCH_FEE_LAMPORTS,
        });

        Ok(())
    }

    pub fn execute_pool_switch_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecutePoolSwitchSwap<'info>>,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.remaining_accounts.len() <= MAX_SWITCH_REMAINING_ACCOUNTS,
            MoonzError::InvalidAmount
        );

        require!(
            swap_data.len() <= MAX_SWITCH_SWAP_DATA_LEN,
            MoonzError::InvalidAmount
        );

        require!(
            ctx.accounts.swap_program.to_account_info().executable,
            MoonzError::InvalidVault
        );

        require!(
            allowed_switch_swap_program(ctx.accounts.swap_program.key()),
            MoonzError::InvalidVault
        );

        let launch_state_key = ctx.accounts.launch_state.key();
        require_launch_state_pda(&ctx.accounts.launch_state, launch_state_key)?;
        require_launch_immutable_and_finalized(&ctx.accounts.launch_state)?;

        let state = ctx.accounts.launch_state.state;
        let quote_asset = ctx.accounts.launch_state.quote_asset;
        let pending_quote_asset = ctx.accounts.launch_state.pending_quote_asset;
        let mint = ctx.accounts.launch_state.mint;
        let bump = ctx.accounts.launch_state.bump;
        let treasury_wsol_vault = ctx.accounts.launch_state.treasury_wsol_vault;
        let treasury_usdc_vault = ctx.accounts.launch_state.treasury_usdc_vault;
        let approved_amount_in = ctx.accounts.launch_state.switch_amount_in;
        let approved_min_amount_out = ctx.accounts.launch_state.switch_min_amount_out;
        let switch_started_at = ctx.accounts.launch_state.switch_started_at;

        require!(
            state == LaunchPhase::Switching as u8,
            MoonzError::InvalidState
        );

        require!(
            !ctx.accounts.launch_state.switch_swap_executed,
            MoonzError::InvalidState
        );
        // The executable transaction cannot alter the pool amount or minimum
        // accepted by the creator during begin_pool_switch.
        let amount_in = approved_amount_in;
        let min_amount_out = approved_min_amount_out;

        require!(amount_in > 0, MoonzError::InvalidState);

        require!(min_amount_out > 0, MoonzError::InvalidState);

        let now = Clock::get()?.unix_timestamp;
        let switch_deadline = switch_started_at
            .checked_add(POOL_SWITCH_CANCEL_TIMEOUT_SECONDS)
            .ok_or(MoonzError::MathOverflow)?;
        require!(now < switch_deadline, MoonzError::SwitchExecutionExpired);

        require!(valid_quote_asset(quote_asset), MoonzError::InvalidAmount);

        require!(
            valid_quote_asset(pending_quote_asset),
            MoonzError::InvalidAmount
        );

        require!(quote_asset != pending_quote_asset, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            MoonzError::Unauthorized
        );

        require_keys_eq!(
            ctx.accounts.source_quote_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.destination_quote_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        if quote_asset == QUOTE_ASSET_WSOL && pending_quote_asset == QUOTE_ASSET_USDC {
            require_keys_eq!(
                ctx.accounts.source_quote_vault.key(),
                treasury_wsol_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.source_quote_vault.mint,
                WSOL_MINT,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.destination_quote_vault.key(),
                treasury_usdc_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.destination_quote_vault.mint,
                USDC_MINT,
                MoonzError::InvalidVault
            );
        } else if quote_asset == QUOTE_ASSET_USDC && pending_quote_asset == QUOTE_ASSET_WSOL {
            require_keys_eq!(
                ctx.accounts.source_quote_vault.key(),
                treasury_usdc_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.source_quote_vault.mint,
                USDC_MINT,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.destination_quote_vault.key(),
                treasury_wsol_vault,
                MoonzError::InvalidVault
            );

            require_keys_eq!(
                ctx.accounts.destination_quote_vault.mint,
                WSOL_MINT,
                MoonzError::InvalidVault
            );
        } else {
            return err!(MoonzError::InvalidState);
        }

        // Jupiter must never receive PDA signing authority while either
        // Moonz quote vault has an external delegate or separate close
        // authority. These vaults are expected to be controlled only by
        // the canonical LaunchState PDA.
        require!(
            ctx.accounts.source_quote_vault.delegate.is_none()
                && ctx.accounts.source_quote_vault.delegated_amount == 0,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.source_quote_vault.close_authority.is_none(),
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.destination_quote_vault.delegate.is_none()
                && ctx.accounts.destination_quote_vault.delegated_amount == 0,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.destination_quote_vault.close_authority.is_none(),
            MoonzError::InvalidVault
        );

        let source_before = ctx.accounts.source_quote_vault.amount;
        let destination_before = ctx.accounts.destination_quote_vault.amount;

        require!(source_before >= amount_in, MoonzError::InvalidState);

        let protected_token_accounts = [
            ctx.accounts.launch_state.sale_vault,
            ctx.accounts.launch_state.lp_vault,
        ];

        let signer_seeds: &[&[u8]] = &[
            b"launch_state",
            mint.as_ref(),
            &[bump],
        ];

        invoke_checked_jupiter_swap(
            &ctx.accounts.swap_program.to_account_info(),
            launch_state_key,
            ctx.accounts.source_quote_vault.key(),
            ctx.accounts.destination_quote_vault.key(),
            ctx.accounts.source_quote_vault.mint,
            ctx.accounts.destination_quote_vault.mint,
            &protected_token_accounts,
            ctx.remaining_accounts,
            &swap_data,
            signer_seeds,
        )?;

        ctx.accounts.source_quote_vault.reload()?;
        ctx.accounts.destination_quote_vault.reload()?;

        // The swap may change balances only. Authority, mint, delegate and
        // close-authority state must remain exactly within Moonz control.
        require_keys_eq!(
            ctx.accounts.source_quote_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.destination_quote_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.source_quote_vault.delegate.is_none()
                && ctx.accounts.source_quote_vault.delegated_amount == 0,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.source_quote_vault.close_authority.is_none(),
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.destination_quote_vault.delegate.is_none()
                && ctx.accounts.destination_quote_vault.delegated_amount == 0,
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.destination_quote_vault.close_authority.is_none(),
            MoonzError::InvalidVault
        );

        let source_after = ctx.accounts.source_quote_vault.amount;
        let destination_after = ctx.accounts.destination_quote_vault.amount;

        require!(source_after <= source_before, MoonzError::MathOverflow);

        require!(
            destination_after >= destination_before,
            MoonzError::MathOverflow
        );

        let source_decrease = source_before
            .checked_sub(source_after)
            .ok_or(MoonzError::MathOverflow)?;

        let destination_increase = destination_after
            .checked_sub(destination_before)
            .ok_or(MoonzError::MathOverflow)?;

        require!(source_decrease == amount_in, MoonzError::SlippageExceeded);

        require!(
            destination_increase >= min_amount_out,
            MoonzError::SlippageExceeded
        );

        let st = &mut ctx.accounts.launch_state;
        st.switch_swap_executed = true;
        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(PoolSwitchSwapExecutedEvent {
            mint,
            executor: ctx.accounts.platform_signer.key(),
            from_asset: quote_asset,
            to_asset: pending_quote_asset,
            amount_in,
            amount_out: destination_increase,
            source_remaining: source_after,
            destination_balance: destination_after,
        });

        Ok(())
    }

    pub fn complete_pool_switch(ctx: Context<CompletePoolSwitch>) -> Result<()> {
        let launch_state_key = ctx.accounts.launch_state.key();

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::Switching as u8,
            MoonzError::InvalidState
        );

        require!(st.switch_swap_executed, MoonzError::InvalidState);

        require!(
            valid_quote_asset(st.pending_quote_asset),
            MoonzError::InvalidAmount
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        let wsol_amount = ctx.accounts.treasury_wsol_vault.amount;
        let usdc_amount = ctx.accounts.treasury_usdc_vault.amount;

        if st.pending_quote_asset == QUOTE_ASSET_USDC {
            require!(usdc_amount > 0, MoonzError::InsufficientTreasuryLiquidity);
        }

        if st.pending_quote_asset == QUOTE_ASSET_WSOL {
            require!(wsol_amount > 0, MoonzError::InsufficientTreasuryLiquidity);
        }

        let switch_fee = st.switch_fee_escrowed_lamports;

        require!(
            switch_fee == POOL_SWITCH_FEE_LAMPORTS,
            MoonzError::InvalidState
        );

        {
            let launch_ai = st.to_account_info();
            let platform_fee_ai = ctx.accounts.platform_fee_receiver.to_account_info();

            **launch_ai.try_borrow_mut_lamports()? = launch_ai
                .lamports()
                .checked_sub(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;

            **platform_fee_ai.try_borrow_mut_lamports()? = platform_fee_ai
                .lamports()
                .checked_add(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;
        }

        st.quote_asset = st.pending_quote_asset;
        st.last_pool_switch_ts = Clock::get()?.unix_timestamp;
        st.switch_started_at = 0;
        st.switch_fee_escrowed_lamports = 0;
        st.switch_amount_in = 0;
        st.switch_min_amount_out = 0;
        st.switch_swap_executed = false;
        st.state = LaunchPhase::AmmLive as u8;

        emit!(PoolSwitchCompletedEvent {
            mint: st.mint,
            creator: st.creator,
            new_asset: st.quote_asset,
        });

        Ok(())
    }

    pub fn cancel_pool_switch(ctx: Context<CancelPoolSwitch>) -> Result<()> {
        let launch_state_key = ctx.accounts.launch_state.key();
        let now = Clock::get()?.unix_timestamp;

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::Switching as u8,
            MoonzError::InvalidState
        );

        require!(!st.switch_swap_executed, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.creator.key(),
            st.creator,
            MoonzError::Unauthorized
        );

        require!(valid_quote_asset(st.quote_asset), MoonzError::InvalidAmount);

        require!(
            valid_quote_asset(st.pending_quote_asset),
            MoonzError::InvalidAmount
        );

        let elapsed = now
            .checked_sub(st.switch_started_at)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            elapsed >= POOL_SWITCH_CANCEL_TIMEOUT_SECONDS,
            MoonzError::EscrowTimeoutNotReached
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require!(
            (st.quote_asset == QUOTE_ASSET_WSOL && st.pending_quote_asset == QUOTE_ASSET_USDC)
                || (st.quote_asset == QUOTE_ASSET_USDC
                    && st.pending_quote_asset == QUOTE_ASSET_WSOL),
            MoonzError::InvalidState
        );

        let switch_fee = st.switch_fee_escrowed_lamports;

        require!(
            switch_fee == POOL_SWITCH_FEE_LAMPORTS,
            MoonzError::InvalidState
        );

        {
            let launch_ai = st.to_account_info();
            let creator_ai = ctx.accounts.creator.to_account_info();

            **launch_ai.try_borrow_mut_lamports()? = launch_ai
                .lamports()
                .checked_sub(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;

            **creator_ai.try_borrow_mut_lamports()? = creator_ai
                .lamports()
                .checked_add(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;
        }

        st.pending_quote_asset = st.quote_asset;
        st.switch_started_at = 0;
        st.switch_fee_escrowed_lamports = 0;
        st.switch_amount_in = 0;
        st.switch_min_amount_out = 0;
        st.switch_swap_executed = false;
        st.state = LaunchPhase::AmmLive as u8;

        emit!(PoolSwitchCancelledEvent {
            mint: st.mint,
            creator: st.creator,
            active_asset: st.quote_asset,
            cancelled_at: now,
        });

        Ok(())
    }

    /// Platform-only immediate abort for a pool switch that cannot be executed safely.
    /// Used when the backend determines that the Jupiter route exceeds protocol CPI caps
    /// or cannot satisfy the account boundary before executing the swap. This restores trading
    /// immediately on the original quote asset and returns the 0.5 SOL switch fee to the creator.
    pub fn abort_pool_switch_route_invalid(
        ctx: Context<AbortPoolSwitchRouteInvalid>,
    ) -> Result<()> {
        let launch_state_key = ctx.accounts.launch_state.key();
        let now = Clock::get()?.unix_timestamp;

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::Switching as u8,
            MoonzError::InvalidState
        );

        require!(!st.switch_swap_executed, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            MoonzError::Unauthorized
        );

        require_keys_eq!(
            ctx.accounts.creator.key(),
            st.creator,
            MoonzError::Unauthorized
        );

        require!(valid_quote_asset(st.quote_asset), MoonzError::InvalidAmount);

        require!(
            valid_quote_asset(st.pending_quote_asset),
            MoonzError::InvalidAmount
        );

        require!(
            st.pending_quote_asset != st.quote_asset,
            MoonzError::InvalidState
        );

        let switch_fee = st.switch_fee_escrowed_lamports;

        require!(
            switch_fee == POOL_SWITCH_FEE_LAMPORTS,
            MoonzError::InvalidState
        );

        {
            let launch_ai = st.to_account_info();
            let creator_ai = ctx.accounts.creator.to_account_info();

            **launch_ai.try_borrow_mut_lamports()? = launch_ai
                .lamports()
                .checked_sub(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;

            **creator_ai.try_borrow_mut_lamports()? = creator_ai
                .lamports()
                .checked_add(switch_fee)
                .ok_or(MoonzError::MathOverflow)?;
        }

        st.pending_quote_asset = st.quote_asset;
        st.switch_started_at = 0;
        st.switch_fee_escrowed_lamports = 0;
        st.switch_amount_in = 0;
        st.switch_min_amount_out = 0;
        st.switch_swap_executed = false;
        st.state = LaunchPhase::AmmLive as u8;

        emit!(PoolSwitchCancelledEvent {
            mint: st.mint,
            creator: st.creator,
            active_asset: st.quote_asset,
            cancelled_at: now,
        });

        Ok(())
    }

    // AMM - USDC quote asset

    pub fn amm_buy_usdc(
        ctx: Context<AmmBuyUsdcCtx>,
        usdc_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        require!(usdc_in >= MIN_USDC_TRADE_UNITS, MoonzError::InvalidAmount);
        require!(min_tokens_out > 0, MoonzError::InvalidAmount);

        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            MoonzError::InvalidState
        );

        require!(st.quote_asset == QUOTE_ASSET_USDC, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.buyer_usdc_ata.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_usdc_vault.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_usdc_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.owner,
            PLATFORM_FEE_WALLET,
            MoonzError::PlatformMismatch
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_usdc_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            USDC_MINT,
        )?;

        require_canonical_ata(
            ctx.accounts.platform_usdc_ata.key(),
            PLATFORM_FEE_WALLET,
            USDC_MINT,
        )?;

        let quote_reserve = ctx.accounts.treasury_usdc_vault.amount as u128;
        let tok_reserve = ctx.accounts.lp_vault.amount as u128;

        require!(quote_reserve > 0, MoonzError::InsufficientTreasuryLiquidity);
        require!(tok_reserve > 0, MoonzError::InsufficientSaleLiquidity);

        let usdc_in_u128 = usdc_in as u128;

        let total_fee = bps_amount(usdc_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let usdc_trade = usdc_in_u128
            .checked_sub(total_fee)
            .ok_or(MoonzError::MathOverflow)?;

        let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fee)?;

        let tokens_out = amm_buy_tokens_out(usdc_trade, quote_reserve, tok_reserve)?;

        require!(tokens_out > 0, MoonzError::ZeroOutput);

        require!(
            tokens_out >= min_tokens_out as u128,
            MoonzError::SlippageExceeded
        );

        let usdc_to_pool = usdc_trade
            .checked_add(lp_fee)
            .ok_or(MoonzError::MathOverflow)?;

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
                        to: ctx.accounts.creator_fee_usdc_vault.to_account_info(),
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

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        emit!(AmmBuyEvent {
            mint,
            user: ctx.accounts.buyer.key(),
            quote_asset: QUOTE_ASSET_USDC,
            input_amount: usdc_in,
            input_mint: USDC_MINT,
            output_amount: tokens_out as u64,
            output_mint: mint,
            quote_amount: usdc_in,
            token_amount: tokens_out as u64,
            trade_fee: total_fee as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: lp_fee as u64,
            tokens_sold_total: st.tokens_sold,
            quote_collected_total: quote_reserve
                .checked_add(usdc_to_pool)
                .ok_or(MoonzError::MathOverflow)? as u64,
            timestamp: st.last_trade_ts,
        });

        Ok(())
    }

    pub fn amm_sell_usdc(
        ctx: Context<AmmSellUsdcCtx>,
        tokens_in: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        require!(
            tokens_in >= MIN_TOKEN_TRADE_UNITS,
            MoonzError::InvalidAmount
        );
        require!(min_usdc_out > 0, MoonzError::InvalidAmount);

        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        require!(
            st.state == LaunchPhase::AmmLive as u8,
            MoonzError::InvalidState
        );

        require!(st.quote_asset == QUOTE_ASSET_USDC, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.seller_usdc_ata.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_usdc_vault.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.mint,
            USDC_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.treasury_usdc_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_usdc_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_usdc_ata.owner,
            PLATFORM_FEE_WALLET,
            MoonzError::PlatformMismatch
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_usdc_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            USDC_MINT,
        )?;

        require_canonical_ata(
            ctx.accounts.platform_usdc_ata.key(),
            PLATFORM_FEE_WALLET,
            USDC_MINT,
        )?;

        let quote_reserve_before: u128 = ctx.accounts.treasury_usdc_vault.amount as u128;

        let tok_reserve_before: u128 = ctx.accounts.lp_vault.amount as u128;

        require!(
            tok_reserve_before > 0,
            MoonzError::InsufficientSaleLiquidity
        );

        require!(
            quote_reserve_before > 0,
            MoonzError::InsufficientTreasuryLiquidity
        );

        let usdc_gross: u128 =
            amm_sell_sol_out_gross(tokens_in as u128, quote_reserve_before, tok_reserve_before)?;

        require!(usdc_gross > 0, MoonzError::ZeroOutput);

        let total_fees = bps_amount(usdc_gross, TRADE_FEE_TOTAL_BPS as u128)?;

        let (lp_fee, creator_fee, platform_fee) = split_amm_fee(total_fees)?;

        let usdc_net: u128 = usdc_gross
            .checked_sub(total_fees)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            usdc_net >= min_usdc_out as u128,
            MoonzError::SlippageExceeded
        );

        let actual_outflow = usdc_net
            .checked_add(creator_fee)
            .ok_or(MoonzError::MathOverflow)?
            .checked_add(platform_fee)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            actual_outflow <= quote_reserve_before,
            MoonzError::InsufficientTreasuryLiquidity
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

        let seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[bump]];

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
                        to: ctx.accounts.creator_fee_usdc_vault.to_account_info(),
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
            user: ctx.accounts.seller.key(),
            quote_asset: QUOTE_ASSET_USDC,
            input_amount: tokens_in,
            input_mint: mint,
            output_amount: usdc_net as u64,
            output_mint: USDC_MINT,
            quote_amount: usdc_gross as u64,
            token_amount: tokens_in,
            trade_fee: total_fees as u64,
            creator_fee: creator_fee as u64,
            platform_fee: platform_fee as u64,
            lp_fee: lp_fee as u64,
            tokens_sold_total: st.tokens_sold,
            quote_collected_total: quote_reserve_before
                .checked_sub(actual_outflow)
                .ok_or(MoonzError::MathOverflow)? as u64,
            timestamp: st.last_trade_ts,
        });

        Ok(())
    }

    pub fn settle_escrow_to_platform(ctx: Context<SettleEscrow>) -> Result<()> {
        let launch_state_key = ctx.accounts.launch_state.key();
        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;
        let mint = st.mint;

        require!(st.dev_buy_done, MoonzError::InvalidState);
        require!(!st.escrow_settled, MoonzError::InvalidState);

        require_keys_eq!(
            ctx.accounts.launch_escrow.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );

        require!(
            ctx.accounts.launch_escrow.executed,
            MoonzError::EscrowNotFunded
        );

        require!(
            !ctx.accounts.launch_escrow.refunded,
            MoonzError::EscrowRefundUnavailable
        );

        require_keys_eq!(
            ctx.accounts.launch_fee_receiver.key(),
            LAUNCH_FEE_WALLET,
            MoonzError::InvalidFeeReceiver
        );

        let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
        let launch_fee_ai = ctx.accounts.launch_fee_receiver.to_account_info();

        let transferable = escrow_ai.lamports();

        let escrow_bump = st.escrow_sol_bump;

        let seeds: &[&[u8]] = &[b"escrow_sol", mint.as_ref(), &[escrow_bump]];

        if transferable > 0 {
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
        }

        st.escrow_settled = true;

        Ok(())
    }

    pub fn dev_buy_start_curve_from_escrow(
        ctx: Context<DevBuyStartCurveFromEscrow>,
        min_tokens_out: u64,
        ipfs_cid: String,
    ) -> Result<()> {
        require!(min_tokens_out > 0, MoonzError::InvalidAmount);

        require_keys_eq!(
            ctx.accounts.platform_signer.key(),
            PLATFORM_WALLET,
            MoonzError::Unauthorized
        );

        require!(ipfs_cid.as_bytes().len() <= 120, MoonzError::InvalidAmount);

        let mint = ctx.accounts.launch_state.mint;
        let launch_bump = ctx.accounts.launch_state.bump;
        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_ai = ctx.accounts.launch_state.to_account_info();

        let launch_signer_seeds: &[&[u8]] = &[b"launch_state", mint.as_ref(), &[launch_bump]];

        let st = &mut ctx.accounts.launch_state;
        require_launch_state_pda(st, launch_state_key)?;
        require_launch_immutable_and_finalized(st)?;

        let launch_escrow = &mut ctx.accounts.launch_escrow;

        require_keys_eq!(st.mint, ctx.accounts.mint.key(), MoonzError::InvalidVault);
        require_keys_eq!(
            launch_escrow.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );
        require_keys_eq!(
            launch_escrow.creator,
            st.creator,
            MoonzError::InvalidEscrowCreator
        );
        require_keys_eq!(
            ctx.accounts.creator_receiver.key(),
            st.creator,
            MoonzError::InvalidFeeReceiver
        );

        require!(launch_escrow.initialized, MoonzError::InvalidState);
        require!(
            min_tokens_out == launch_escrow.dev_buy_min_tokens_out,
            MoonzError::SlippageExceeded
        );
        require!(!launch_escrow.executed, MoonzError::EscrowAlreadyExecuted);
        require!(!launch_escrow.refunded, MoonzError::EscrowRefundUnavailable);

        let now = Clock::get()?.unix_timestamp;

        require_launch_execution_allowed(
            launch_escrow.created_at,
            launch_escrow.executed,
            launch_escrow.refunded,
            now,
        )?;

        require!(
            st.state == LaunchPhase::PendingDevBuy as u8,
            MoonzError::InvalidState
        );

        require!(!st.dev_buy_done, MoonzError::InvalidState);

        let wsol_in = launch_escrow.dev_buy_lamports;
        require!(wsol_in > 0, MoonzError::InvalidAmount);

        require_keys_eq!(
            ctx.accounts.sale_vault.mint,
            st.mint,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_ata.mint,
            st.mint,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_ata.owner,
            st.creator,
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.mint,
            WSOL_MINT,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            ctx.accounts.creator_fee_wsol_vault.owner,
            ctx.accounts.creator_fee_authority.key(),
            MoonzError::InvalidFeeReceiver
        );

        require_keys_eq!(
            ctx.accounts.platform_wsol_ata.owner,
            PLATFORM_FEE_WALLET,
            MoonzError::PlatformMismatch
        );

        require_canonical_ata(
            ctx.accounts.creator_fee_wsol_vault.key(),
            ctx.accounts.creator_fee_authority.key(),
            WSOL_MINT,
        )?;

        require_canonical_ata(
            ctx.accounts.platform_wsol_ata.key(),
            PLATFORM_FEE_WALLET,
            WSOL_MINT,
        )?;

        require_keys_eq!(
            ctx.accounts.treasury_wsol_vault.owner,
            launch_state_key,
            MoonzError::InvalidVault
        );

        let sale_remaining: u128 = st
            .sale_supply
            .checked_sub(st.tokens_sold)
            .ok_or(MoonzError::MathOverflow)? as u128;

        require!(sale_remaining > 0, MoonzError::InsufficientSaleLiquidity);

        require!(
            (min_tokens_out as u128) <= sale_remaining,
            MoonzError::InsufficientSaleLiquidity
        );

        let wsol_in_u128: u128 = wsol_in as u128;

        let base_fee_max = bps_amount(wsol_in_u128, TRADE_FEE_TOTAL_BPS as u128)?;

        let wsol_eff_max = wsol_in_u128
            .checked_sub(base_fee_max)
            .ok_or(MoonzError::MathOverflow)?;

        let (tokens_out_raw, _, _) =
            curve_buy(wsol_eff_max, st.sol_collected as u128, sale_remaining, 0)?;

        require!(tokens_out_raw > 0, MoonzError::ZeroOutput);
        require!(tokens_out_raw < sale_remaining, MoonzError::InvalidAmount);

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
            MoonzError::SlippageExceeded
        );

        let wsol_in_used = gross_from_net(wsol_eff_used, TRADE_FEE_TOTAL_BPS as u128)?;

        require!(wsol_in_used <= wsol_in_u128, MoonzError::MathOverflow);

        let base_fee_used = wsol_in_used
            .checked_sub(wsol_eff_used)
            .ok_or(MoonzError::MathOverflow)?;

        let (creator_fee, platform_fee) = split_bonding_fee(base_fee_used)?;

        let treasury_amount = wsol_eff_used;

        let required_lamports = creator_fee
            .checked_add(platform_fee)
            .ok_or(MoonzError::MathOverflow)?
            .checked_add(treasury_amount)
            .ok_or(MoonzError::MathOverflow)?;

        let unused_dev_buy = wsol_in_u128
            .checked_sub(wsol_in_used)
            .ok_or(MoonzError::MathOverflow)?;

        let total_required_lamports = required_lamports
            .checked_add(unused_dev_buy)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            total_required_lamports
                <= ctx.accounts.escrow_sol_vault.to_account_info().lamports() as u128,
            MoonzError::InsufficientTreasuryLiquidity
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
                        to: ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                creator_fee as u64,
            )?;

            sync_native_token_account(
                ctx.accounts.creator_fee_wsol_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            )?;
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

            sync_native_token_account(
                ctx.accounts.platform_wsol_ata.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            )?;
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

            sync_native_token_account(
                ctx.accounts.treasury_wsol_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            )?;
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
        ctx.accounts.creator_fee_wsol_vault.reload()?;
        ctx.accounts.platform_wsol_ata.reload()?;

        st.tokens_sold = st
            .tokens_sold
            .checked_add(tokens_out as u64)
            .ok_or(MoonzError::MathOverflow)?;

        st.sol_collected = st
            .sol_collected
            .checked_add(wsol_eff_used)
            .ok_or(MoonzError::MathOverflow)?;

        st.last_trade_ts = Clock::get()?.unix_timestamp;

        require!(st.tokens_sold <= st.sale_supply, MoonzError::MathOverflow);

        st.dev_buy_done = true;
        st.state = LaunchPhase::Curve as u8;

        launch_escrow.executed = true;

        let curve_change_u128 = V_SOL
            .checked_add(wsol_in_used)
            .ok_or(MoonzError::MathOverflow)?;

        require!(
            curve_change_u128 <= u64::MAX as u128,
            MoonzError::MathOverflow
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
        dev_buy_min_tokens_out: u64,
        metadata_commitment: [u8; 32],
    ) -> Result<()> {
        require!(
            dev_buy_lamports >= MIN_WSOL_TRADE_LAMPORTS,
            MoonzError::InvalidAmount
        );
        require!(dev_buy_min_tokens_out > 0, MoonzError::InvalidAmount);
        require!(metadata_commitment != [0u8; 32], MoonzError::InvalidAmount);

        // Do not fail on dust-prefunded launch escrow PDAs. Creation below accepts only
        // system-owned zero-data PDAs and rejects already initialized escrow accounts.

        let mint_key = ctx.accounts.mint.key();

        let total_deposit = CREATE_FEE_LAMPORTS
            .checked_add(dev_buy_lamports)
            .ok_or(MoonzError::MathOverflow)?;

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
        launch_escrow.dev_buy_min_tokens_out = dev_buy_min_tokens_out;
        launch_escrow.deposited_lamports = total_deposit;
        launch_escrow.metadata_commitment = metadata_commitment;

        launch_escrow.created_at = Clock::get()?.unix_timestamp;

        launch_escrow.executed = false;
        launch_escrow.refunded = false;
        launch_escrow.initialized = false;

        let mut data = escrow_ai.data.borrow_mut();
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        launch_escrow.try_serialize(&mut cursor)?;

        emit!(LaunchEscrowFundedEvent {
            mint: mint_key,
            creator: ctx.accounts.creator.key(),
            create_fee_lamports: CREATE_FEE_LAMPORTS,
            dev_buy_lamports,
            dev_buy_min_tokens_out,
            deposited_lamports: total_deposit,
        });

        Ok(())
    }

    pub fn cancel_initialized_launch(ctx: Context<CancelInitializedLaunch>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let launch_state_key = ctx.accounts.launch_state.key();
        let launch_state = &mut ctx.accounts.launch_state;
        let launch_escrow = &mut ctx.accounts.launch_escrow;

        require_launch_state_pda(launch_state, launch_state_key)?;
        require_keys_eq!(
            launch_state.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );
        require_keys_eq!(
            launch_state.creator,
            ctx.accounts.creator.key(),
            MoonzError::Unauthorized
        );
        require_keys_eq!(
            launch_escrow.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );
        require_keys_eq!(
            launch_escrow.creator,
            ctx.accounts.creator.key(),
            MoonzError::InvalidEscrowCreator
        );

        require!(launch_escrow.initialized, MoonzError::InvalidState);
        require!(!launch_escrow.executed, MoonzError::EscrowAlreadyExecuted);
        require!(!launch_escrow.refunded, MoonzError::EscrowRefundUnavailable);
        require!(!launch_state.dev_buy_done, MoonzError::InvalidState);
        require!(
            launch_state.state == LaunchPhase::PendingDevBuy as u8,
            MoonzError::InvalidState
        );

        require_launch_refund_allowed(
            launch_escrow.created_at,
            launch_escrow.executed,
            launch_escrow.refunded,
            now,
        )?;

        let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
        let creator_ai = ctx.accounts.creator.to_account_info();
        let refundable_lamports = escrow_ai.lamports();
        require!(refundable_lamports > 0, MoonzError::InvalidAmount);

        let mint_key = ctx.accounts.mint.key();
        let escrow_seeds: &[&[u8]] = &[
            b"escrow_sol",
            mint_key.as_ref(),
            &[launch_escrow.escrow_sol_bump],
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
        launch_state.state = LaunchPhase::Cancelled as u8;

        emit!(LaunchEscrowRefundedEvent {
            mint: mint_key,
            creator: ctx.accounts.creator.key(),
            refunded_lamports: refundable_lamports,
        });

        Ok(())
    }

    pub fn refund_launch_escrow(ctx: Context<RefundLaunchEscrow>) -> Result<()> {
        let launch_escrow = &mut ctx.accounts.launch_escrow;

        require!(
            launch_escrow.creator == ctx.accounts.creator.key(),
            MoonzError::InvalidEscrowCreator
        );

        require_keys_eq!(
            launch_escrow.mint,
            ctx.accounts.mint.key(),
            MoonzError::InvalidVault
        );

        require!(!launch_escrow.executed, MoonzError::EscrowAlreadyExecuted);
        require!(!launch_escrow.refunded, MoonzError::EscrowRefundUnavailable);

        require!(
            !launch_escrow.initialized,
            MoonzError::EscrowAlreadyExecuted
        );

        let now = Clock::get()?.unix_timestamp;

        require_launch_refund_allowed(
            launch_escrow.created_at,
            launch_escrow.executed,
            launch_escrow.refunded,
            now,
        )?;

        let escrow_ai = ctx.accounts.escrow_sol_vault.to_account_info();
        let creator_ai = ctx.accounts.creator.to_account_info();

        let refundable_lamports = escrow_ai.lamports();

        require!(refundable_lamports > 0, MoonzError::InvalidAmount);

        let mint_key = ctx.accounts.mint.key();
        let escrow_bump = launch_escrow.escrow_sol_bump;

        let escrow_seeds: &[&[u8]] = &[b"escrow_sol", mint_key.as_ref(), &[escrow_bump]];

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

/// helper functions

fn invoke_checked_jupiter_swap<'info>(
    swap_program: &AccountInfo<'info>,
    authority_key: Pubkey,
    source_vault_key: Pubkey,
    destination_vault_key: Pubkey,
    source_mint_key: Pubkey,
    destination_mint_key: Pubkey,
    protected_token_accounts: &[Pubkey],
    remaining_accounts: &[AccountInfo<'info>],
    swap_data: &[u8],
    signer_seeds: &[&[u8]],
) -> Result<()> {
    require!(
        remaining_accounts.len()
            <= MAX_SWITCH_REMAINING_ACCOUNTS,
        MoonzError::InvalidAmount
    );

    require!(
        swap_data.len()
            <= MAX_SWITCH_SWAP_DATA_LEN,
        MoonzError::InvalidAmount
    );

    require!(
        swap_program.executable,
        MoonzError::InvalidVault
    );

    require!(
        allowed_switch_swap_program(swap_program.key()),
        MoonzError::InvalidVault
    );

    require!(
        swap_data.len() >= 8,
        MoonzError::InvalidAmount
    );

    let discriminator = &swap_data[..8];

    if discriminator == JUPITER_ROUTE_DISCRIMINATOR.as_ref() {
        // Jupiter v6 `route` fixed account ABI:
        // 0 tokenProgram
        // 1 userTransferAuthority
        // 2 userSourceTokenAccount
        // 3 userDestinationTokenAccount
        // 5 destinationMint
        require!(
            remaining_accounts.len() >= 6,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[0].key(),
            token::ID,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[1].key(),
            authority_key,
            MoonzError::Unauthorized
        );

        require_keys_eq!(
            remaining_accounts[2].key(),
            source_vault_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[3].key(),
            destination_vault_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[5].key(),
            destination_mint_key,
            MoonzError::InvalidVault
        );
    } else if discriminator
        == JUPITER_SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR.as_ref()
    {
        // Jupiter v6 `sharedAccountsRoute` fixed account ABI:
        // 0 tokenProgram
        // 1 programAuthority
        // 2 userTransferAuthority
        // 3 sourceTokenAccount
        // 4 programSourceTokenAccount
        // 5 programDestinationTokenAccount
        // 6 destinationTokenAccount
        // 7 sourceMint
        // 8 destinationMint
        require!(
            remaining_accounts.len() >= 9,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[0].key(),
            token::ID,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[2].key(),
            authority_key,
            MoonzError::Unauthorized
        );

        require_keys_eq!(
            remaining_accounts[3].key(),
            source_vault_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[6].key(),
            destination_vault_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[7].key(),
            source_mint_key,
            MoonzError::InvalidVault
        );

        require_keys_eq!(
            remaining_accounts[8].key(),
            destination_mint_key,
            MoonzError::InvalidVault
        );
    } else {
        // Reject ExactOut, token-ledger and every non-swap Jupiter
        // instruction before LaunchState PDA signer privilege is created.
        return err!(MoonzError::Unauthorized);
    }

    let mut metas: Vec<AccountMeta> =
        Vec::with_capacity(remaining_accounts.len());

    let mut infos: Vec<AccountInfo> =
        Vec::with_capacity(remaining_accounts.len() + 1);

    // Jupiter instructions use an ordered AccountMeta ABI and may
    // legitimately repeat the same external account at multiple positions.
    // Do not deduplicate or reorder Jupiter accounts.
    //
    // Moonz-controlled accounts remain non-aliasable: authority, source and
    // destination must each occur exactly once.
    require!(
        authority_key != source_vault_key
            && authority_key != destination_vault_key
            && source_vault_key != destination_vault_key,
        MoonzError::InvalidVault
    );

    let mut authority_count: usize = 0;
    let mut source_vault_count: usize = 0;
    let mut destination_vault_count: usize = 0;

    for ai in remaining_accounts.iter() {
        let key = ai.key();

        if key == authority_key {
            authority_count = authority_count
                .checked_add(1)
                .ok_or(MoonzError::MathOverflow)?;
        }

        if key == source_vault_key {
            source_vault_count = source_vault_count
                .checked_add(1)
                .ok_or(MoonzError::MathOverflow)?;

            require!(
                ai.is_writable,
                MoonzError::InvalidVault
            );
        }

        if key == destination_vault_key {
            destination_vault_count = destination_vault_count
                .checked_add(1)
                .ok_or(MoonzError::MathOverflow)?;

            require!(
                ai.is_writable,
                MoonzError::InvalidVault
            );
        }

        // Production pool switching passes its sale and LP vaults
        // here so Jupiter can never touch Moonz token inventory.
        require!(
            !protected_token_accounts
                .iter()
                .any(|protected| *protected == key),
            MoonzError::InvalidVault
        );

        // The only signer allowed inside Jupiter is the PDA authority
        // supplied by the calling Moonz instruction.
        require!(
            !ai.is_signer || key == authority_key,
            MoonzError::Unauthorized
        );

        // Jupiter may legitimately place its own program ID inside the
        // ordered account ABI, including repeated readonly sentinel/route
        // positions. It must never receive signer or writable privilege.
        if key == swap_program.key() {
            require!(
                !ai.is_signer && !ai.is_writable,
                MoonzError::InvalidVault
            );
        }

        // Jupiter may not touch any arbitrary SPL token account
        // owned by the signing PDA. Only the explicitly selected
        // source and destination vaults are permitted.
        if *ai.owner == token::ID
            && ai.data_len()
                == anchor_spl::token::TokenAccount::LEN
        {
            let token_account =
                TokenAccount::try_deserialize_unchecked(
                    &mut &ai.data.borrow()[..]
                )?;

            if token_account.owner == authority_key {
                require!(
                    key == source_vault_key
                        || key == destination_vault_key,
                    MoonzError::InvalidVault
                );
            }
        }

        let is_signer =
            key == authority_key;

        // The PDA never needs Jupiter to write to its authority
        // account itself. Explicitly de-escalate it to readonly.
        let is_writable =
            if key == authority_key {
                false
            } else {
                ai.is_writable
            };

        if is_writable {
            metas.push(
                AccountMeta::new(
                    key,
                    is_signer,
                )
            );
        } else {
            metas.push(
                AccountMeta::new_readonly(
                    key,
                    is_signer,
                )
            );
        }

        infos.push(ai.clone());
    }

    require!(
        authority_count == 1,
        MoonzError::InvalidVault
    );

    require!(
        source_vault_count == 1,
        MoonzError::InvalidVault
    );

    require!(
        destination_vault_count == 1,
        MoonzError::InvalidVault
    );

    // Raw CPI requires the executable program AccountInfo.
    infos.push(swap_program.clone());

    let ix = Instruction {
        program_id: swap_program.key(),
        accounts: metas,
        data: swap_data.to_vec(),
    };

    invoke_signed(
        &ix,
        &infos,
        &[signer_seeds],
    )?;

    Ok(())
}

fn sync_native_token_account<'info>(
    token_account: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let ix =
        anchor_spl::token::spl_token::instruction::sync_native(&token::ID, &token_account.key())?;

    invoke(&ix, &[token_account, token_program])?;

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
            MoonzError::InvalidVault
        );

        require!(
            pda.to_account_info().data_len() == space,
            MoonzError::InvalidVault
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
    let pda_ai = pda.to_account_info();
    let rent_lamports = rent.minimum_balance(space);

    if pda_ai.lamports() == 0 {
        let ix = system_instruction::create_account(
            &escrow.key(),
            &pda.key(),
            rent_lamports,
            space as u64,
            owner,
        );

        invoke_signed(
            &ix,
            &[
                escrow.to_account_info(),
                pda_ai,
                system_program.to_account_info(),
            ],
            &[escrow_signer_seeds, pda_seeds],
        )?;

        return Ok(());
    }

    if *pda_ai.owner == system_program::ID {
        require!(pda_ai.data_len() == 0, MoonzError::InvalidVault);

        if pda_ai.lamports() < rent_lamports {
            let top_up = rent_lamports
                .checked_sub(pda_ai.lamports())
                .ok_or(MoonzError::MathOverflow)?;

            let ix = system_instruction::transfer(&escrow.key(), &pda.key(), top_up);
            invoke_signed(
                &ix,
                &[
                    escrow.to_account_info(),
                    pda_ai.clone(),
                    system_program.to_account_info(),
                ],
                &[escrow_signer_seeds],
            )?;
        }

        let allocate_ix = system_instruction::allocate(&pda.key(), space as u64);
        invoke_signed(
            &allocate_ix,
            &[pda_ai.clone(), system_program.to_account_info()],
            &[pda_seeds],
        )?;

        let assign_ix = system_instruction::assign(&pda.key(), owner);
        invoke_signed(
            &assign_ix,
            &[pda_ai, system_program.to_account_info()],
            &[pda_seeds],
        )?;

        return Ok(());
    }

    err!(MoonzError::InvalidState)
}

/// Accounts

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct InitializeLaunch<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    /// CHECK: static mint authority PDA derived from MINT_AUTHORITY_SEED and verified by seeds.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_escrow.creator == params.creator @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: LaunchState PDA is created manually during initialize_launch using escrow SOL, then serialized as LaunchState.
    #[account(mut, seeds = [b"launch_state", mint.key().as_ref()], bump)]
    pub launch_state: UncheckedAccount<'info>,

    /// CHECK: SPL token account PDA is created manually during initialize_launch, then initialized as the bonding sale vault.
    #[account(mut, seeds = [b"sale_vault", mint.key().as_ref()], bump)]
    pub sale_vault: UncheckedAccount<'info>,

    /// CHECK: SPL token account PDA is created manually during initialize_launch, then initialized as the AMM LP token vault.
    #[account(mut, seeds = [b"lp_vault", mint.key().as_ref()], bump)]
    pub lp_vault: UncheckedAccount<'info>,

    /// CHECK: WSOL token account PDA is created manually during initialize_launch, then initialized as the launch WSOL treasury vault.
    #[account(mut, seeds = [b"treasury_wsol", mint.key().as_ref()], bump)]
    pub treasury_wsol_vault: UncheckedAccount<'info>,

    /// CHECK: USDC token account PDA is created manually during initialize_launch, then initialized as the launch USDC treasury vault.
    #[account(mut, seeds = [b"treasury_usdc", mint.key().as_ref()], bump)]
    pub treasury_usdc_vault: UncheckedAccount<'info>,

    /// CHECK: native SOL system-account PDA used as escrow funding source. PDA is verified by seeds and signs account creation.
    #[account(mut, seeds = [b"escrow_sol", mint.key().as_ref()], bump)]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(metadata_bump: u8, params: MetadataParams)]
pub struct InitializeMetadata<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub payer: Signer<'info>,

    /// CHECK: static mint authority PDA derived from MINT_AUTHORITY_SEED and verified by seeds.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump,
        constraint = launch_state.mint == mint.key() @ MoonzError::InvalidVault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    /// CHECK: Metaplex metadata PDA derived from ["metadata", token_metadata_program, mint] and verified by seeds/program.
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

    /// CHECK: verified by address constraint against the official Metaplex Token Metadata program ID.
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    #[account(
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_escrow.creator == launch_state.creator @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,
}

#[derive(Accounts)]
#[instruction(metadata_bump: u8)]
pub struct FinalizeMintAuthorities<'info> {
    #[account(address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    /// CHECK: static mint authority PDA derived from MINT_AUTHORITY_SEED and verified by seeds.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump,
        constraint = launch_state.mint == mint.key() @ MoonzError::InvalidVault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    /// CHECK: Metaplex metadata PDA derived from ["metadata", token_metadata_program, mint] and verified by seeds/program.
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

    #[account(
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_escrow.creator == launch_state.creator @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,
}

#[derive(Accounts)]
pub struct DevBuyStartCurveFromEscrow<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump,
        constraint = launch_state.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_state.sale_vault == sale_vault.key() @ MoonzError::InvalidVault,
        constraint = launch_state.treasury_wsol_vault == treasury_wsol_vault.key() @ MoonzError::InvalidVault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    /// CHECK: native SOL escrow PDA verified by seeds and launch escrow bump.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_escrow.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    /// CHECK: native SOL receiver must equal launch_state.creator.
    #[account(mut, address = launch_state.creator)]
    pub creator_receiver: UncheckedAccount<'info>,

    #[account(
        mut,
        address = launch_state.sale_vault,
        constraint = sale_vault.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = sale_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub sale_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = creator_ata.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = creator_ata.owner == launch_state.creator @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_wsol_vault,
        constraint = treasury_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = treasury_wsol_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_wsol_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, launch_state.creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, launch_state.creator.as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = creator_fee_wsol_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = platform_wsol_ata.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = platform_wsol_ata.owner == PLATFORM_FEE_WALLET @ MoonzError::PlatformMismatch
    )]
    pub platform_wsol_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump,
        has_one = sale_vault,
        has_one = lp_vault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        address = launch_state.sale_vault,
        constraint = sale_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = sale_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub sale_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.lp_vault,
        constraint = lp_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = lp_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub lp_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_ata.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = buyer_ata.owner == buyer.key() @ MoonzError::Unauthorized
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_wsol_ata.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = buyer_wsol_ata.owner == buyer.key() @ MoonzError::Unauthorized
    )]
    pub buyer_wsol_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_wsol_vault,
        constraint = treasury_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = treasury_wsol_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_wsol_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, launch_state.creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, launch_state.creator.as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = creator_fee_wsol_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = platform_wsol_ata.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = platform_wsol_ata.owner == PLATFORM_FEE_WALLET @ MoonzError::PlatformMismatch
    )]
    pub platform_wsol_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump,
        has_one = sale_vault,
        has_one = lp_vault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        address = launch_state.sale_vault,
        constraint = sale_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = sale_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub sale_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.lp_vault,
        constraint = lp_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = lp_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub lp_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_ata.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = seller_ata.owner == seller.key() @ MoonzError::Unauthorized
    )]
    pub seller_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_wsol_ata.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = seller_wsol_ata.owner == seller.key() @ MoonzError::Unauthorized
    )]
    pub seller_wsol_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_wsol_vault,
        constraint = treasury_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = treasury_wsol_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_wsol_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, launch_state.creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, launch_state.creator.as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = creator_fee_wsol_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = platform_wsol_ata.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = platform_wsol_ata.owner == PLATFORM_FEE_WALLET @ MoonzError::PlatformMismatch
    )]
    pub platform_wsol_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, creator.key().as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = creator_receiver_ata.owner == creator.key() @ MoonzError::InvalidFeeReceiver,
        constraint = creator_receiver_ata.mint == creator_fee_vault.mint @ MoonzError::InvalidVault
    )]
    pub creator_receiver_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BeginPoolSwitch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        constraint = source_quote_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub source_quote_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: platform wallet identity check kept for compatibility.
    /// The switch fee is escrowed into launch_state and released on complete_pool_switch.
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_wallet: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecutePoolSwitchSwap<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(mut)]
    pub source_quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_quote_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: external swap program. Runtime checks require the executable Jupiter v6 program.
    pub swap_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CompletePoolSwitch<'info> {
    /// CHECK: retained for client compatibility. Completion is permissionless after
    /// the approved swap has executed and all deterministic vault checks pass.
    #[account(address = PLATFORM_WALLET)]
    pub platform_signer: UncheckedAccount<'info>,

    /// CHECK: receives successful native SOL pool-switch fee.
    #[account(mut, address = PLATFORM_FEE_WALLET)]
    pub platform_fee_receiver: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        address = launch_state.treasury_wsol_vault,
        constraint = treasury_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = treasury_wsol_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_usdc_vault,
        constraint = treasury_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = treasury_usdc_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_usdc_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct CancelPoolSwitch<'info> {
    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(mut, address = launch_state.creator)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        address = launch_state.treasury_wsol_vault,
        constraint = treasury_wsol_vault.mint == WSOL_MINT @ MoonzError::InvalidVault,
        constraint = treasury_wsol_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_usdc_vault,
        constraint = treasury_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = treasury_usdc_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_usdc_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct AbortPoolSwitchRouteInvalid<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    /// CHECK: receives refunded native SOL switch fee and is verified against launch_state.creator.
    #[account(mut, address = launch_state.creator)]
    pub creator: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform_signer: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump,
        constraint = launch_state.mint == mint.key() @ MoonzError::InvalidVault
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        close = launch_fee_receiver,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_escrow.creator == launch_state.creator @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,

    /// CHECK: receives leftover escrow SOL after successful launch and is verified by address.
    #[account(mut, address = LAUNCH_FEE_WALLET)]
    pub launch_fee_receiver: UncheckedAccount<'info>,

    /// CHECK: native SOL escrow PDA verified by seeds and launch_state escrow bump.
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
pub struct AmmBuyUsdcCtx<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        address = launch_state.lp_vault,
        constraint = lp_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = lp_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub lp_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_ata.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = buyer_ata.owner == buyer.key() @ MoonzError::Unauthorized
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_usdc_ata.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = buyer_usdc_ata.owner == buyer.key() @ MoonzError::Unauthorized
    )]
    pub buyer_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_usdc_vault,
        constraint = treasury_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = treasury_usdc_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, launch_state.creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, launch_state.creator.as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = creator_fee_usdc_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = platform_usdc_ata.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = platform_usdc_ata.owner == PLATFORM_FEE_WALLET @ MoonzError::PlatformMismatch
    )]
    pub platform_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AmmSellUsdcCtx<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_state", launch_state.mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    #[account(
        mut,
        address = launch_state.lp_vault,
        constraint = lp_vault.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = lp_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub lp_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_ata.mint == launch_state.mint @ MoonzError::InvalidVault,
        constraint = seller_ata.owner == seller.key() @ MoonzError::Unauthorized
    )]
    pub seller_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_usdc_ata.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = seller_usdc_ata.owner == seller.key() @ MoonzError::Unauthorized
    )]
    pub seller_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = launch_state.treasury_usdc_vault,
        constraint = treasury_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = treasury_usdc_vault.owner == launch_state.key() @ MoonzError::InvalidVault
    )]
    pub treasury_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Global creator fee authority PDA.
    /// One PDA per creator wallet: [CREATOR_FEES_SEED, launch_state.creator].
    #[account(
        seeds = [CREATOR_FEES_SEED, launch_state.creator.as_ref()],
        bump
    )]
    pub creator_fee_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = creator_fee_usdc_vault.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = creator_fee_usdc_vault.owner == creator_fee_authority.key() @ MoonzError::InvalidFeeReceiver
    )]
    pub creator_fee_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = platform_usdc_ata.mint == USDC_MINT @ MoonzError::InvalidVault,
        constraint = platform_usdc_ata.owner == PLATFORM_FEE_WALLET @ MoonzError::PlatformMismatch
    )]
    pub platform_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FundLaunchEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: the planned mint key must sign TX0, preventing another wallet from
    /// pre-funding and squatting this mint's deterministic launch PDAs.
    pub mint: Signer<'info>,

    /// CHECK: launch escrow state PDA is created manually from escrow SOL and serialized as LaunchEscrow.
    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump
    )]
    pub launch_escrow: UncheckedAccount<'info>,

    /// CHECK: native SOL escrow PDA created by this instruction and verified by seeds.
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
pub struct CancelInitializedLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        close = creator,
        constraint = launch_escrow.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_escrow.creator == creator.key() @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,

    #[account(
        mut,
        seeds = [b"launch_state", mint.key().as_ref()],
        bump = launch_state.bump,
        constraint = launch_state.mint == mint.key() @ MoonzError::InvalidVault,
        constraint = launch_state.creator == creator.key() @ MoonzError::Unauthorized
    )]
    pub launch_state: Box<Account<'info, LaunchState>>,

    /// CHECK: native SOL escrow PDA verified by seeds and launch escrow bump.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_escrow.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundLaunchEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: mint address used only for PDA derivation and verified against launch_escrow.mint by runtime logic.
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"launch_escrow", mint.key().as_ref()],
        bump = launch_escrow.bump,
        close = creator,
        constraint = launch_escrow.creator == creator.key() @ MoonzError::InvalidEscrowCreator
    )]
    pub launch_escrow: Box<Account<'info, LaunchEscrow>>,

    /// CHECK: native SOL escrow PDA verified by seeds and launch escrow bump.
    #[account(
        mut,
        seeds = [b"escrow_sol", mint.key().as_ref()],
        bump = launch_escrow.escrow_sol_bump
    )]
    pub escrow_sol_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod launch_timeout_security_tests {
    use super::*;

    const CREATED_AT: i64 = 1_000_000;

    fn execution_allowed(
        offset_seconds: i64,
        executed: bool,
        refunded: bool,
    ) -> bool {
        require_launch_execution_allowed(
            CREATED_AT,
            executed,
            refunded,
            CREATED_AT + offset_seconds,
        )
        .is_ok()
    }

    fn refund_allowed(
        offset_seconds: i64,
        executed: bool,
        refunded: bool,
    ) -> bool {
        require_launch_refund_allowed(
            CREATED_AT,
            executed,
            refunded,
            CREATED_AT + offset_seconds,
        )
        .is_ok()
    }

    #[test]
    fn plus_299_execution_succeeds_refund_fails() {
        assert!(execution_allowed(299, false, false));
        assert!(!refund_allowed(299, false, false));
    }

    #[test]
    fn plus_300_execution_fails_refund_succeeds() {
        assert!(!execution_allowed(300, false, false));
        assert!(refund_allowed(300, false, false));
    }

    #[test]
    fn plus_301_execution_fails_refund_succeeds() {
        assert!(!execution_allowed(301, false, false));
        assert!(refund_allowed(301, false, false));
    }

    #[test]
    fn refund_after_successful_execution_fails() {
        assert!(!refund_allowed(300, true, false));
        assert!(!refund_allowed(301, true, false));
    }

    #[test]
    fn execution_after_refund_fails() {
        assert!(!execution_allowed(299, false, true));
    }

    #[test]
    fn execution_and_refund_windows_are_exact_complements() {
        for offset in 0_i64..=1_800_i64 {
            let execute =
                execution_allowed(offset, false, false);

            let refund =
                refund_allowed(offset, false, false);

            assert!(
                !(execute && refund),
                "overlap at offset {}",
                offset
            );

            assert!(
                execute || refund,
                "gap at offset {}",
                offset
            );
        }
    }

    #[test]
    fn deadline_overflow_fails_safely() {
        let created_at = i64::MAX - 299;

        assert!(
            require_launch_execution_allowed(
                created_at,
                false,
                false,
                i64::MAX,
            )
            .is_err()
        );

        assert!(
            require_launch_refund_allowed(
                created_at,
                false,
                false,
                i64::MAX,
            )
            .is_err()
        );
    }
}
