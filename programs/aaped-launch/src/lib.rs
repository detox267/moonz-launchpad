use anchor_lang::prelude::*;

declare_id!("Bq4d5j6vAT2y6VNJ6zTtNu5uTkiotZdacyC26JtG1qYc");

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
