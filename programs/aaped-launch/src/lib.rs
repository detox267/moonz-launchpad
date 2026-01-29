use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use solana_program::{program::invoke_signed, system_instruction};

pub mod errors;
pub mod math;
pub mod state;

use state::{LaunchState, SaleState};

declare_id!("Bq4d5j6vAT2y6VNJ6zTtNu5uTkiotZdacyC26JtG1qYc");

fn create_pda_system_account<'info>(
    payer: &Signer<'info>,
    pda: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    signer_seeds: &[&[u8]],
) -> Result<()> {

    if pda.lamports() > 0 {
        return Ok(());
    }

    
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(0);

    let ix = system_instruction::create_account(
        &payer.key(),
        &pda.key(),
        lamports,
        0,
        &system_program::ID,
    );

    invoke_signed(
        &ix,
        &[
            payer.to_account_info(),
            pda.to_account_info(),
            system_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    Ok(())
}

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        creator: Pubkey,
        platform: Pubkey,
    ) -> Result<()> {
        let mint = ctx.accounts.mint.key();

        
        let lp_signer_seeds: &[&[u8]] = &[
            b"lp_vault",
            mint.as_ref(),
            &[ctx.bumps.lp_vault],
        ];
        let tail_signer_seeds: &[&[u8]] = &[
            b"tail_vault",
            mint.as_ref(),
            &[ctx.bumps.tail_vault],
        ];

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.lp_vault,
            &ctx.accounts.system_program,
            lp_signer_seeds,
        )?;

        create_pda_system_account(
            &ctx.accounts.payer,
            &ctx.accounts.tail_vault,
            &ctx.accounts.system_program,
            tail_signer_seeds,
        )?;

        
        let st = &mut ctx.accounts.state;

        st.state = SaleState::Curve;
        st.sold_tokens = 0;
        st.sol_collected = 0;

        st.creator = creator;
        st.platform = platform;

        st.lp_vault = ctx.accounts.lp_vault.key();
        st.tail_vault = ctx.accounts.tail_vault.key();
        st.sale_vault = ctx.accounts.sale_vault.key();
        st.mint = mint;

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
        mut,
        seeds = [b"lp_vault", mint.key().as_ref()],
        bump
    )]
    pub lp_vault: UncheckedAccount<'info>,

    
    #[account(
        mut,
        seeds = [b"tail_vault", mint.key().as_ref()],
        bump
    )]
    pub tail_vault: UncheckedAccount<'info>,

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

