# Desktop 0.4 verification

Historical snapshot from October 2026, preserved from desktop/README.md. It does not describe current release or signing status. See [current development documentation](../../desktop/README.md).

The saved Primary Budget export was re-audited without writing to the live database: 48 account balance checks, 1,107 category-month checks and 27 unassigned-money (Ready to Assign) checks, all with zero differences. Native UI workflows are exercised in a separate QA database. Private evidence is under `../migration-2026-10-15/parity-0.4/` (ignored).

Native QA verified quick assign preview/apply, manual assignment undo, reports, bank-file preview/import, repeat-file duplicate detection, running balances, and bulk approval against an isolated copy. The live budget stayed at revision 9 with 2,656 transactions throughout development.

The sealed secrets file is tested on every system with a throwaway key file; DPAPI and Credential Manager have round-trip tests on Windows, and the Keychain trial item has one that writes throwaway items to the login Keychain (`cargo test keychain -- --ignored`). A fresh authenticated import with a real token requires the user's credential. Automated tests cover merge conflicts and the review UI without accessing real credentials. The app is a locally built macOS bundle, without notarization or an automatic update service.
