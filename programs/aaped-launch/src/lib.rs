use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

pub mod errors;
pub mod math;
pub mod state;

use state::{LaunchState, SaleState};

declare_id!("Bq4d5j6vAT2y6VNJ6zTtNu5uTkiotZdacyC26JtG1qYc");

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        creator: Pubkey,
        platform: Pubkey,
    ) -> Result<()> {
        let st = &mut ctx.accounts.state;

        st.state = SaleState::Curve;
        st.sold_tokens = 0;
        st.sol_collected = 0;

        st.creator = creator;
        st.platform = platform;

        st.lp_vault = ctx.accounts.lp_vault.key();
        st.tail_vault = ctx.accounts.tail_vault.key();
        st.sale_vault = ctx.accounts.sale_vault.key();
        st.mint = ctx.accounts.mint.key();

        st.state_bump = ctx.bumps.state;
        st.lp_bump = ctx.bumps.lp_vault;
        st.tail_bump = ctx.bumps.tail_vault;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(creator: Pubkey, platform: Pubkey)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = LaunchState::LEN,
        seeds = [b"state", mint.key().as_ref()],
        bump
    )]
    pub state: Account<'info, LaunchState>,

    #[account(
        init,
        payer = payer,
        space = 8, // just a system account (no data)
        seeds = [b"lp_vault", mint.key().as_ref()],
        bump
    )]
    pub lp_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8, // just a system account (no data)
        seeds = [b"tail_vault", mint.key().as_ref()],
        bump
    )]
    pub tail_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = state
    )]
    pub sale_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
