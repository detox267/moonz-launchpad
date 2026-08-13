use anchor_lang::prelude::*;
use anchor_spl::token::{
    self,
    Approve,
    SetAuthority,
    Token,
    TokenAccount,
    Transfer,
};

// Default test build keeps the historical standalone mock-swap ID.
// The dedicated Jupiter security fixture is built with
// `--features jupiter-fixture` and declares the real Jupiter v6 address
// so Anchor's generated program-ID check succeeds when the local
// validator loads this TEST-ONLY binary at JUP6....
#[cfg(not(feature = "jupiter-fixture"))]
declare_id!("7QyZeftmo4HQ2Ayub8vhbB1nK6mtprknYNSXW1XjsLts");

#[cfg(feature = "jupiter-fixture")]
declare_id!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

#[program]
pub mod mock_swap {
    use super::*;

    pub fn mock_switch_swap(
        ctx: Context<MockSwitchSwap>,
        amount_in: u64,
        amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, MockSwapError::InvalidAmount);
        require!(amount_out > 0, MockSwapError::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source_quote_vault.to_account_info(),
                    to: ctx.accounts.source_sink_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_donor_ata.to_account_info(),
                    to: ctx.accounts.destination_quote_vault.to_account_info(),
                    authority: ctx.accounts.usdc_donor_authority.to_account_info(),
                },
            ),
            amount_out,
        )?;

        Ok(())
    }

    /// Test-only fixture using the real Jupiter v6 `route`
    /// Anchor discriminator: sha256("global:route")[0..8].
    ///
    /// IMPORTANT:
    /// This is NOT Jupiter's deployed implementation and does NOT
    /// deserialize Jupiter's real RoutePlan argument schema.
    /// It exists only to exercise Moonz CPI discriminator/account-role
    /// enforcement with a local program loaded at Jupiter's address.
    pub fn route(
        ctx: Context<JupiterRouteFixture>,
        amount_in: u64,
        amount_out: u64,
        mutation_mode: u8,
    ) -> Result<()> {
        require!(amount_in > 0, MockSwapError::InvalidAmount);
        require!(amount_out > 0, MockSwapError::InvalidAmount);

        require_keys_eq!(
            ctx.accounts.user_source_token_account.mint,
            ctx.accounts.source_sink_vault.mint,
            MockSwapError::InvalidMint
        );

        require_keys_eq!(
            ctx.accounts.user_destination_token_account.mint,
            ctx.accounts.destination_mint.key(),
            MockSwapError::InvalidMint
        );

        require_keys_eq!(
            ctx.accounts.destination_token_account.mint,
            ctx.accounts.destination_mint.key(),
            MockSwapError::InvalidMint
        );

        let (expected_donor_authority, bump) =
            Pubkey::find_program_address(
                &[b"mock_donor"],
                ctx.program_id,
            );

        require_keys_eq!(
            ctx.accounts.fixture_donor_authority.key(),
            expected_donor_authority,
            MockSwapError::InvalidFixtureAuthority
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_source_token_account.to_account_info(),
                    to: ctx.accounts.source_sink_vault.to_account_info(),
                    authority: ctx.accounts.user_transfer_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        let bump_seed = [bump];
        let donor_seeds: &[&[u8]] = &[
            b"mock_donor",
            &bump_seed,
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.destination_token_account.to_account_info(),
                    to: ctx.accounts.user_destination_token_account.to_account_info(),
                    authority: ctx.accounts.fixture_donor_authority.to_account_info(),
                },
                &[donor_seeds],
            ),
            amount_out,
        )?;

        apply_fixture_mutation(
            mutation_mode,
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.user_transfer_authority.to_account_info(),
            ctx.accounts.user_source_token_account.to_account_info(),
            ctx.accounts.user_destination_token_account.to_account_info(),
            ctx.accounts.fixture_donor_authority.to_account_info(),
        )?;

        Ok(())
    }

    /// Test-only fixture using the real Jupiter v6
    /// `sharedAccountsRoute` Anchor discriminator:
    /// sha256("global:shared_accounts_route")[0..8].
    ///
    /// IMPORTANT:
    /// This is NOT Jupiter's deployed implementation and does NOT
    /// deserialize Jupiter's real RoutePlan argument schema.
    pub fn shared_accounts_route(
        ctx: Context<JupiterSharedAccountsRouteFixture>,
        amount_in: u64,
        amount_out: u64,
        mutation_mode: u8,
    ) -> Result<()> {
        require!(amount_in > 0, MockSwapError::InvalidAmount);
        require!(amount_out > 0, MockSwapError::InvalidAmount);

        require_keys_eq!(
            ctx.accounts.source_token_account.mint,
            ctx.accounts.source_mint.key(),
            MockSwapError::InvalidMint
        );

        require_keys_eq!(
            ctx.accounts.program_source_token_account.mint,
            ctx.accounts.source_mint.key(),
            MockSwapError::InvalidMint
        );

        require_keys_eq!(
            ctx.accounts.destination_token_account.mint,
            ctx.accounts.destination_mint.key(),
            MockSwapError::InvalidMint
        );

        require_keys_eq!(
            ctx.accounts.program_destination_token_account.mint,
            ctx.accounts.destination_mint.key(),
            MockSwapError::InvalidMint
        );

        let (expected_donor_authority, bump) =
            Pubkey::find_program_address(
                &[b"mock_donor"],
                ctx.program_id,
            );

        require_keys_eq!(
            ctx.accounts.fixture_donor_authority.key(),
            expected_donor_authority,
            MockSwapError::InvalidFixtureAuthority
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source_token_account.to_account_info(),
                    to: ctx.accounts.program_source_token_account.to_account_info(),
                    authority: ctx.accounts.user_transfer_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        let bump_seed = [bump];
        let donor_seeds: &[&[u8]] = &[
            b"mock_donor",
            &bump_seed,
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.program_destination_token_account.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: ctx.accounts.fixture_donor_authority.to_account_info(),
                },
                &[donor_seeds],
            ),
            amount_out,
        )?;

        apply_fixture_mutation(
            mutation_mode,
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.user_transfer_authority.to_account_info(),
            ctx.accounts.source_token_account.to_account_info(),
            ctx.accounts.destination_token_account.to_account_info(),
            ctx.accounts.fixture_donor_authority.to_account_info(),
        )?;

        Ok(())
    }
}

/// Test-only mutation modes used to prove that Moonz detects and
/// atomically rolls back token-account authority-state changes made
/// during an otherwise allowlisted Jupiter-shaped CPI.
///
/// 0 = no mutation
/// 1 = source delegate
/// 2 = destination delegate
/// 3 = source close authority
/// 4 = destination close authority
/// 5 = source token-account owner
/// 6 = destination token-account owner
fn apply_fixture_mutation<'info>(
    mutation_mode: u8,
    token_program: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    source: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    mutation_target: AccountInfo<'info>,
) -> Result<()> {
    match mutation_mode {
        0 => {}

        1 => {
            token::approve(
                CpiContext::new(
                    token_program,
                    Approve {
                        to: source,
                        delegate: mutation_target,
                        authority,
                    },
                ),
                1,
            )?;
        }

        2 => {
            token::approve(
                CpiContext::new(
                    token_program,
                    Approve {
                        to: destination,
                        delegate: mutation_target,
                        authority,
                    },
                ),
                1,
            )?;
        }

        3 => {
            token::set_authority(
                CpiContext::new(
                    token_program,
                    SetAuthority {
                        current_authority: authority,
                        account_or_mint: source,
                    },
                ),
                token::spl_token::instruction::AuthorityType::CloseAccount,
                Some(mutation_target.key()),
            )?;
        }

        4 => {
            token::set_authority(
                CpiContext::new(
                    token_program,
                    SetAuthority {
                        current_authority: authority,
                        account_or_mint: destination,
                    },
                ),
                token::spl_token::instruction::AuthorityType::CloseAccount,
                Some(mutation_target.key()),
            )?;
        }

        5 => {
            token::set_authority(
                CpiContext::new(
                    token_program,
                    SetAuthority {
                        current_authority: authority,
                        account_or_mint: source,
                    },
                ),
                token::spl_token::instruction::AuthorityType::AccountOwner,
                Some(mutation_target.key()),
            )?;
        }

        6 => {
            token::set_authority(
                CpiContext::new(
                    token_program,
                    SetAuthority {
                        current_authority: authority,
                        account_or_mint: destination,
                    },
                ),
                token::spl_token::instruction::AuthorityType::AccountOwner,
                Some(mutation_target.key()),
            )?;
        }

        _ => {
            return err!(MockSwapError::InvalidMutationMode);
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct MockSwitchSwap<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub source_quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub source_sink_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub usdc_donor_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_quote_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub usdc_donor_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Fixed account order intentionally mirrors Jupiter v6 `route`:
///
/// 0 tokenProgram
/// 1 userTransferAuthority
/// 2 userSourceTokenAccount
/// 3 userDestinationTokenAccount
/// 4 destinationTokenAccount
/// 5 destinationMint
///
/// Accounts after index 5 are fixture-only dynamic accounts.
#[derive(Accounts)]
pub struct JupiterRouteFixture<'info> {
    pub token_program: Program<'info, Token>,

    pub user_transfer_authority: Signer<'info>,

    #[account(mut)]
    pub user_source_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_destination_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Moonz validates this fixed Jupiter ABI position
    /// against the expected destination mint.
    pub destination_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub source_sink_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: test-only PDA derived from the runtime fixture program ID.
    pub fixture_donor_authority: UncheckedAccount<'info>,
}

/// Fixed account order intentionally mirrors Jupiter v6
/// `sharedAccountsRoute`:
///
/// 0 tokenProgram
/// 1 programAuthority
/// 2 userTransferAuthority
/// 3 sourceTokenAccount
/// 4 programSourceTokenAccount
/// 5 programDestinationTokenAccount
/// 6 destinationTokenAccount
/// 7 sourceMint
/// 8 destinationMint
///
/// Account after index 8 is fixture-only.
#[derive(Accounts)]
pub struct JupiterSharedAccountsRouteFixture<'info> {
    pub token_program: Program<'info, Token>,

    /// CHECK: Jupiter-owned/program authority role placeholder.
    pub program_authority: UncheckedAccount<'info>,

    pub user_transfer_authority: Signer<'info>,

    #[account(mut)]
    pub source_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub program_source_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub program_destination_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Moonz validates this fixed Jupiter ABI position.
    pub source_mint: UncheckedAccount<'info>,

    /// CHECK: Moonz validates this fixed Jupiter ABI position.
    pub destination_mint: UncheckedAccount<'info>,

    /// CHECK: test-only PDA derived from the runtime fixture program ID.
    pub fixture_donor_authority: UncheckedAccount<'info>,
}

#[error_code]
pub enum MockSwapError {
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Invalid fixture mint")]
    InvalidMint,

    #[msg("Invalid fixture authority")]
    InvalidFixtureAuthority,

    #[msg("Invalid fixture mutation mode")]
    InvalidMutationMode,
}
