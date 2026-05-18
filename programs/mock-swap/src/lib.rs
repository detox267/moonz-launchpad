use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("PUT_MOCK_SWAP_PROGRAM_ID_HERE");

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

#[error_code]
pub enum MockSwapError {
    #[msg("Invalid amount")]
    InvalidAmount,
}
