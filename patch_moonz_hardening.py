#!/usr/bin/env python3
"""
Moonz / AAPED Anchor hardening patch.

Run from your repo root:

    python3 patch_moonz_hardening.py

Or pass the repo root:

    python3 patch_moonz_hardening.py /root/aaped-launch
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def die(msg: str) -> None:
    print(f"\nERROR: {msg}")
    sys.exit(1)


def find_src(root: Path) -> Path:
    candidate = root / "programs" / "aaped-launch" / "src"
    if candidate.exists():
        return candidate

    if (root / "lib.rs").exists() and (root / "state.rs").exists():
        return root

    die(
        "Could not find Anchor source folder. Run from repo root or pass repo path. "
        "Expected programs/aaped-launch/src or direct src folder."
    )


def read(path: Path) -> str:
    if not path.exists():
        die(f"Missing file: {path}")
    return path.read_text()


def write_with_backup(path: Path, text: str) -> None:
    backup = path.with_suffix(path.suffix + ".pre_moonz_hardening_patch")
    if not backup.exists():
        shutil.copy2(path, backup)
        print(f"backup: {backup}")
    path.write_text(text)
    print(f"patched: {path}")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        if new in text:
            print(f"skip already patched: {label}")
            return text
        die(f"Could not find expected block for: {label}")
    return text.replace(old, new, 1)


def insert_before(text: str, marker: str, insert: str, label: str) -> str:
    if insert.strip() in text:
        print(f"skip already patched: {label}")
        return text
    if marker not in text:
        die(f"Could not find marker for: {label}")
    return text.replace(marker, insert + marker, 1)


def insert_after(text: str, marker: str, insert: str, label: str) -> str:
    if insert.strip() in text:
        print(f"skip already patched: {label}")
        return text
    if marker not in text:
        die(f"Could not find marker for: {label}")
    return text.replace(marker, marker + insert, 1)


def patch_state(state: str) -> str:
    state = replace_once(
        state,
        """    pub executed: bool,
    pub refunded: bool,
""",
        """    pub initialized: bool,
    pub executed: bool,
    pub refunded: bool,
""",
        "LaunchEscrow.initialized field",
    )

    state = replace_once(
        state,
        """        8 +   // created_at
        1 +   // executed
        1;    // refunded
""",
        """        8 +   // created_at
        1 +   // initialized
        1 +   // executed
        1;    // refunded
""",
        "LaunchEscrow LEN initialized byte",
    )

    return state


def patch_lib(lib: str) -> str:
    lib = insert_after(
        lib,
        """pub const MIN_TOKEN_TRADE_UNITS: u64 = 1_000;
""",
        """
/// Launched Moonz tokens are fixed to 6 decimals.
/// The bonding curve math uses 6-decimal token base units, so this must be enforced on-chain.
pub const LAUNCH_TOKEN_DECIMALS: u8 = 6;
""",
        "LAUNCH_TOKEN_DECIMALS constant",
    )

    lib = insert_after(
        lib,
        """        require_keys_eq!(
            mint_auth,
            expected_mint_authority,
            MoonzError::Unauthorized
        );
""",
        """
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

        require!(
            ctx.accounts.mint.supply == 0,
            MoonzError::InvalidAmount
        );

        require!(
            ctx.accounts.mint.decimals == LAUNCH_TOKEN_DECIMALS,
            MoonzError::InvalidAmount
        );
""",
        "mint supply / freeze authority / decimals checks",
    )

    lib = insert_after(
        lib,
        """        let escrow_seeds: &[&[u8]] = &[
            b"escrow_sol",
            mint_key.as_ref(),
            &[escrow_bump],
        ];
""",
        """
        // initialize_launch must be one-time only for a mint.
        // Existing initialized PDAs must not be reused or overwritten.
        require!(
            ctx.accounts.launch_state.to_account_info().lamports() == 0,
            MoonzError::InvalidState
        );

        require!(
            ctx.accounts.sale_vault.to_account_info().lamports() == 0,
            MoonzError::InvalidState
        );

        require!(
            ctx.accounts.lp_vault.to_account_info().lamports() == 0,
            MoonzError::InvalidState
        );

        require!(
            ctx.accounts.treasury_wsol_vault.to_account_info().lamports() == 0,
            MoonzError::InvalidState
        );

        require!(
            ctx.accounts.treasury_usdc_vault.to_account_info().lamports() == 0,
            MoonzError::InvalidState
        );
""",
        "initialize_launch empty PDA checks",
    )

    lib = insert_before(
        lib,
        """        Ok(())
    }

    pub fn initialize_metadata(
""",
        """        ctx.accounts.launch_escrow.initialized = true;

""",
        "mark LaunchEscrow initialized after initialize_launch",
    )

    lib = insert_after(
        lib,
        """    launch_escrow.executed = false;
    launch_escrow.refunded = false;
""",
        """    launch_escrow.initialized = false;
""",
        "fund_launch_escrow sets initialized false",
    )

    lib = insert_before(
        lib,
        """        require!(!launch_escrow.executed, MoonzError::EscrowAlreadyExecuted);
""",
        """        require!(launch_escrow.initialized, MoonzError::InvalidState);
""",
        "dev_buy requires initialized escrow",
    )

    lib = insert_after(
        lib,
        """    require!(!launch_escrow.executed, MoonzError::EscrowAlreadyExecuted);
    require!(!launch_escrow.refunded, MoonzError::EscrowRefundUnavailable);
""",
        """
    require!(
        !launch_escrow.initialized,
        MoonzError::EscrowAlreadyExecuted
    );
""",
        "refund blocked after initialize_launch",
    )

    lib = insert_after(
        lib,
        """            if ai.key() == ctx.accounts.launch_state.lp_vault {
                let token_account = TokenAccount::try_deserialize_unchecked(&mut &ai.data.borrow()[..])?;
                lp_vault_before = Some(token_account.amount);
            }
""",
        """
            // Do not allow a route CPI to write to arbitrary token accounts owned by the launch PDA.
            // Only the selected source and destination quote vaults may be writable launch-owned token accounts.
            if ai.is_writable && ai.data_len() == anchor_spl::token::TokenAccount::LEN {
                let token_account =
                    TokenAccount::try_deserialize_unchecked(&mut &ai.data.borrow()[..])?;

                if token_account.owner == launch_state_key {
                    require!(
                        ai.key() == ctx.accounts.source_quote_vault.key()
                            || ai.key() == ctx.accounts.destination_quote_vault.key(),
                        MoonzError::InvalidVault
                    );
                }
            }
""",
        "execute_pool_switch_swap remaining-account launch-owned token-account guard",
    )

    return lib


def main() -> None:
    root = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else Path.cwd()
    src = find_src(root)

    lib_path = src / "lib.rs"
    state_path = src / "state.rs"
    errors_path = src / "errors.rs"

    lib = read(lib_path)
    state = read(state_path)
    errors = read(errors_path)

    if "MoonzError" not in lib or "MoonzError" not in errors:
        die("MoonzError not found. Make sure you are patching the renamed/current program.")

    if "pub const USDC_MINT: Pubkey" not in lib or "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" not in lib:
        die("Canonical Solana USDC mint not found in lib.rs. Patch that first or verify the file.")

    new_state = patch_state(state)
    new_lib = patch_lib(lib)

    write_with_backup(state_path, new_state)
    write_with_backup(lib_path, new_lib)

    print(
        "\nDone.\n\n"
        "Now run:\n"
        "  anchor build\n\n"
        "Then test:\n"
        "  - wrong decimals mint should fail\n"
        "  - non-zero mint supply should fail\n"
        "  - refund before initialize_launch works after timeout\n"
        "  - refund after initialize_launch fails\n"
        "  - initialize_launch cannot run twice\n"
        "  - switch CPI rejects unexpected writable launch-owned token accounts\n"
    )


if __name__ == "__main__":
    main()
