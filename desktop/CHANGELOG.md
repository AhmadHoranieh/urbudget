# UrBudget changelog

Notable changes to UrBudget, organized using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Once a day, UrBudget counts itself as in use on urbudget.app: only whether this is the copy's first opening, or its first today, this week or this month, with its version, system and whether it came from the Microsoft Store. Nothing identifies you, the computer or your budgets. Settings → Privacy & data → Count this copy as in use turns it off.

## [1.0.8] - 2026-10-22

### Changed

- UrBudget is now free and open source, with nothing locked: there's no trial, license or read-only mode any more.
- Sync, the only paid part, is $3 a month.

## 1.0.7 — 2026-10-21

### Added

- Manage multiple saved YNAB access tokens and choose plans by name.
- Review differences before saving a YNAB import, with an option to ask the assistant for help.
- Compare monthly targets with your expected income.
- Check for and install updates in Microsoft Store copies of UrBudget.

### Changed

- Clearer target deadlines and funding progress.
- Easier transaction selection and simpler menus in the register.
- Smoother budget updates without the page shifting while totals refresh.

### Fixed

- More reliable YNAB imports for split transfers, loan interest, hidden categories, and different currency and number formats.
- Upcoming scheduled transactions in YNAB export files no longer count toward imported balances.
- More accurate Ready to Assign, target calculations, Quick Assign suggestions, and Age of Money.
- Uncategorized spending is included consistently in monthly budget totals.
- Clearing or replacing a transaction's category now saves correctly.
- Previously imported bank transactions can be matched when importing from another source.
- YNAB imports preserve your chosen token and budget name, and correctly apply your choices when reviewing changes.

## 1.0.6 — 2026-10-20

- Loan payoff previews discard results when their inputs change. Card and loan payment dialogs preserve the existing payment when retrying a failed save.
- Bank previews reject invalid dates and unsafe draft amounts before matching transactions. Failed or superseded account-deletion attempts preserve cloud copies until the deletion commits.
- Uncategorized-spending filters refresh after midnight, and split transfers mark every affected budget account correctly.
- Calculation errors keep month navigation, undo, reload and recovery export available. Reports and forecasts hide obsolete results after scope changes or failed refreshes and provide retry controls.
- Retained import metadata no longer merges report transaction counts or skips loan interest. Loan inputs are validated before ledger arithmetic, and scheduled imports reject unknown category references.
- Validate credit-card payment links across edits, imports and sync; preserve paired categories and prevent account-kind changes that would reinterpret existing transactions. Loan payments entered from either transfer side post interest once.
- Quick Assign includes scheduled card payments, weekly funding deadlines and intermediate future shortages. Expired targets stop asking for funding, while snoozed targets still show scheduled needs and overspending.
- Calculations refresh at month rollover, discard obsolete queued reads and offer a separate retry after a calculation failure. Quick Assign shows native resulting balances and rejects confirmations queued across a changed month.
- Selected-month calculations build fewer historical summaries, use credit-only reusable buffers and share schedule indexes. Reports sweep the ledger once, and derived reads release the database lock before calculating.
- Age of Money counts original cash outflow transactions consistently across split representations. Loan payoff searches reject invalid or impossible requests; imports, targets, schedules and forecasts reject malformed dates, unsafe totals and excessive expansion before returning a result.
- Credit-card transfers to tracking accounts reserve payment cash correctly, while card-to-card debt transfers leave payment envelopes for manual reassignment. Positive card balances no longer silently drain assigned payment reserves or let later transactions spend the same cash twice.
- Underfunded Quick Assign covers existing card debt without requiring a target. Same-day card funding respects recorded creation order, and future refill targets use the calculation's reference month consistently.
- Split-transfer expansion copies only each leg's own split, reducing allocation work for large split transactions. See the [Rust engine audit](../docs/RUST-ENGINE.md) for benchmark results and YNAB compatibility limits.
- Reports distinguish missing categories from intentional Unassigned income adjustments. Imported YNAB starting balances stay out of period income, and explicit Unassigned choices survive imports and later edits.
- Desktop and phone reports include net refunds, use split payees consistently, and count transactions once. Income stays visible when filtering expenses; uncategorized spending has its own review link. Budget surplus, cash flow and credit-card payment activity now explain what their totals include.
- YNAB imports identify credit-card payment categories by their protected payment group as well as the account name, so an ordinary category with the same name stays ordinary.
- Reordering accounts no longer changes credit-card payment reserves. Funding follows outstanding purchases, including refunds, while cash overspending keeps priority.
- Amount entry respects decimal-comma formats throughout desktop and phone forms. Retrying a money move after a save failure saves the existing move once, and typing "today" uses the current date.
- Target edits clear incompatible timing settings; weekly and annual meters show this month's funding progress. Underfunded Quick Assign uses actual due dates, including biweekly targets, and can retry failed previews.
- Account forecasts use the selected accounts' spending history, and opening report transactions in the register keeps the complete report scope. Payees support keyboard selection and render large lists efficiently.
- Bank imports distinguish split-transfer legs and source totals, recognize more ID-less transaction details, and let you deliberately import an ambiguous duplicate once. Copies and new scheduled occurrences do not inherit previous bank matches.
- Large budget calculations, bank-import previews and YNAB plan exports reuse indexes and history instead of repeating full scans.
- Cloud sync binds transfers to the signed-in account and passphrase generation, preventing stale uploads after a reset. Credential failures leave account and key changes safely locked. The companion API also protects concurrent login codes and storage limits, handles delayed refunds and deletion callbacks, and routes Google subscription management to Play.
- Preserve the selected repeat frequency when opening a transaction's More options form, and choose an open account when adding a schedule from a closed account's register.
- Protect saved credentials when Android cannot read its encryption key. Running app copies observe credential replacements and deletions, and migrating older credentials preserves newer values saved by another copy.
- Use Android's supported file locking so the phone can create and update its encrypted credential vault.
- Handle future transactions with long imported IDs without blocking other scheduled transactions from posting.
- Transactions on the same date are listed in the order they were added, the latest on top, in registers, activity and report lists, the payee page and exports. Bank-synced transactions use the bank's own time, and imported files keep their statement's order. Transactions you already have keep their current order.
- Flagged transactions keep the column divider beside their flag, and unflagged ones show a hollow flag to click.
- Spending with no category says "Needs a category" in the register, instead of looking like money taken from Unassigned on purpose. The Budget page says how many need one and opens them, accounts with any are marked in the sidebar, and `is:uncategorized` finds them. Uncategorized cash spending reduces Unassigned; uncategorized card purchases add debt without reserving payment cash. Spending can now be saved without a category, as in YNAB, and emptying the category field leaves it empty instead of putting the last choice back. As in YNAB, Unassigned is offered in the category picker for income ("To Unassigned"), not for spending.
- The budget table puts each category on one line. A target meter fills the space between the name and its amounts, what's still needed sits beside Assigned, and only overspending is solid red. Group rows read as headings, a checkbox selects several categories, and each row's menu sits at its end.
- Loans live on their accounts. A debt account's interest rate, payment, escrow or fees and payment category are set in its account settings, where terms from a YNAB import are offered to use. Its register shows what's owed, the payoff date and the interest still to pay, with Record payment and a Payoff planner that tries extra or one-off payments, charging the month's interest the way a recorded payment does, without changing anything. The loan's payment category shows the same in the budget inspector. The separate Loan planner page is gone: open "Loan details & payoff…" from the account's menu.
- The sidebar uses one text size, so account names no longer look larger than everything else. The selected item has an accent bar, and unapproved counts are softer.
- Reports are picked from Spending, Income and Wealth in the page header, with that group's reports as tabs, so charts use the full width.
- A new light theme in the style of macOS: a white page, a soft grey sidebar, finer lines and a clearer blue, with every text colour meeting contrast guidelines.

## 1.0.5 — 2026-10-19

- On a Mac, saved sign-ins, keys and tokens no longer ask for your Keychain password one by one. They're kept together in one encrypted file whose key is UrBudget's only Keychain item. On Windows the file is sealed with Windows' own encryption for your account instead of each secret appearing in Credential Manager. What you've already saved moves over the first time it's used.
- Cloud Sync merges independent edits from different devices and lets you resolve conflicting changes by record, while retaining the local-edit safeguards.
- Phone layouts retain touch selection, the transaction keypad, sheet dialogs and Android Back navigation alongside the desktop interface.
- Android Back dismisses the amount keypad before closing a transaction, preserving the draft and calculating the entered amount.
- Android packages no longer advertise TV support.
- Protect local edits when cloud downloads, scheduled posting and background database checks overlap with changes. Sync stops safely if the open budget changes during a transfer.
- Retrying a failed transaction, recurring transaction or card payment keeps the same entry instead of creating a duplicate. Retrying a failed budget switch reopens the file already created.
- Retrying a YNAB file import after the new budget fails to open reuses that budget instead of creating another copy.
- Fresh Start preserves pending and future transactions, uses settled balances instead of a potentially stale summary, keeps the original currency, and remembers imported bank entries and loan interest already charged. Bank accounts need linking again.
- Transfer edits keep each account's notes and flags on the correct side. Closed-account choices match the saved account, and keyboard clearing uses the receiving account's status.
- Invalid dates stay visible and block saving. Dialogs and popovers handle keyboard focus more consistently.
- Large payee reports render fewer rows while keeping every payee reachable. Large selected registers avoid repeated selection scans while scrolling, and filtered lists no longer flash an empty window.
- Scheduled spending handles tracking-account split transfers correctly and rejects invalid dates and oversized amounts before calculation.
- The register's columns are sized by what they hold. Flag and Cleared are compact icon columns that show names when dragged wider, dates and amounts fit their values, and payee, category and memo share the remaining width. The approval dot sits beside the date, and expanded split lines line up with the table again.
- Scheduled transactions are now one system with the rest, and the Scheduled page is gone. A transaction dated after today is a scheduled transaction: it waits in Scheduled (once, or repeating) and is entered on its date, so it no longer counts in account balances early. Transactions already saved with a later date move there on their own; imported and cleared ones stay as they are. Each register lists its schedules above its transactions under a heading that folds them away and shows what's due in the next 30 days, paused ones included; the Scheduled button lists them all and adds new ones. Enter and Skip open into labelled buttons when you point at a scheduled row; its calendar opens Edit, Pause/Resume and Delete. Save becomes Schedule for a transaction dated ahead, Repeat sits in the register's add row, and a schedule moved to today is entered at once. The hint for adding a flag is an outline.

- Keep recurring schedules intact when retrying a transaction moved to a future date. Editing imported transactions, posted occurrences and loan interest keeps them in the ledger. Adding another future transaction respects its scheduled status even when new transactions normally start cleared.
- Concurrent app copies serialize credential writes; unreadable encrypted data is preserved, and removing a credential also clears a legacy copy left behind by a failed migration.

## 1.0.4 — 2026-10-19

Bank sync with SimpleFIN
- Connect supported US and Canadian banks through SimpleFIN Bridge, link them to your budget accounts, and press Sync to review new transactions. A separate SimpleFIN subscription is required.
- Review, match or skip downloaded transactions before importing. Previously imported transactions are recognized, and payee rules apply to new entries.
- See each linked account's last sync, bank balance and connection details from the sidebar. Connection credentials stay in your computer's secure credential store.

Transactions and card payments
- Record a credit-card payment from the card's register or payment category, with the amount owed, money set aside and a suggested paying account shown together. This records a payment in the budget; it does not move money at your bank.
- Transfers show To/From account names and a shortcut to the matching transaction in the other account. Account registers include a starting-balance row, and scheduled rows show how often they repeat.
- Set, clear and name flags from a dedicated Flag column. Names are saved with the budget and work in search, filters and bulk actions.
- Create a category while entering a transaction. New payee names stay as typed instead of being replaced by a partial match.

Faster everyday work
- Quick Assign calculates its previews together, and saving edits copies less transaction data.
- Large YNAB imports send less unused source data to the interface while preserving it in the saved budget and exports.
- Fast saves no longer flash busy indicators. Settings tabs stay aligned, and budget columns fit when the assistant is open.

Imports, backups and the assistant
- After a file import or bank sync, Categorize with the assistant prepares a request with the new uncategorized transactions attached. Nothing is sent until you press Send.
- Backup retention now applies when automatic and manual backups are created. Recovery and import checks reject stale changes before replacing newer budget data.
- Report an assistant reply inside the app, with a chance to edit the included text before submitting. Settings includes a privacy-policy link, and assistant privacy information explains provider processing and retention more clearly.

## 1.0.3 — 2026-10-18

Payees learn your bank's names for them
- Rename a transaction from a bank file and UrBudget offers to use that name whenever the bank's text comes up again, then to update the earlier ones.
- The Payees page lists the bank names each payee goes by, with any bank text on its transactions that no rule covers yet.
- Rules ignore case and punctuation, and when several match, the longest wins. Imported rows get the payee's default category.
- The import preview shows each new name next to the bank's own text.

Bank files
- Amounts with currency signs or codes ($12.34, 12.34 USD, -12,34 €) and decimal commas (1.234,56) are read. An amount that could be read two ways, such as 1.234, is refused rather than guessed.
- Two-digit years (10/17/26) are read as 2026.
- More column names are recognized: Post Date, Posting Date, Trans. Date, Transaction Description and Amount (USD).
- Tick "Purchases are positive" for card files that list purchases as positive amounts.
- "Help with this import" opens the assistant with the file attached when a file doesn't read the way you expect. Nothing is sent until you press Send.

Also
- YNAB exports saved as tab-separated text import.
- Quick Assign's Underfunded now funds "maintain a balance" targets.
- Notifications are easier to read in dark mode.

[Unreleased]: https://github.com/urbudget/urbudget/compare/desktop-v1.0.8...HEAD
[1.0.8]: https://github.com/urbudget/urbudget/releases/tag/desktop-v1.0.8
