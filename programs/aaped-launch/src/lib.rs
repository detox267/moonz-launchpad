use anchor_lang::prelude::*;
pub mod errors;
pub mod math;
pub mod state;

use errors::ErrorCode;
use state::{LaunchState, SaleState};

declare_id!("Bq4d5j6vAT2y6VNJ6zTtNu5uTkiotZdacyC26JtG1qYc");

#[program]
pub mod aaped_launch {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()>{
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
