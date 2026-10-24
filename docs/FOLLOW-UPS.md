# Follow-ups

Work that's agreed but not done yet. Each entry says where things stand and what done looks like,
so it can be picked up without the conversation it came from. Update an entry as it moves, and
remove it once it's done (the changelog and the guides then describe it).

## Phones: change an assistant proposal before applying it

Added 24 October 2026, on branch `import-editor` ([draft PR](https://github.com/urbudget/urbudget/pull/5)). Not started: the session for it
couldn't set up a worktree (not enough free disk space).

**Where it stands.** On the desktop, an assistant proposal can be changed on its card before it's
applied (commit `e913fcc`): each part has a checkbox to leave it out, rows that can change have a
pencil that opens a category picker and/or an amount under the row, and Apply makes what's left
("Apply 2 of 3"), still one undo step. The engine side is shared and done:
`crates/urbudget-services/src/assistant/proposals.rs` (`revise`, `Revision`, `RowEdit`),
`assistant_revise` in `mod.rs`, and the dispatcher method `assistant_revise` in `dispatch.rs`,
which the phones can already call. The phones list every row of a card (a page at a time) and show
each change as it was and as it will be, but have no checkboxes or editor yet.

**What to build**, on the proposal card of each phone (Android: `AssistantProposalCard` in
`android/app/src/main/java/app/urbudget/nativeapp/ui/AssistantScreen.kt`, with
`AssistantController.kt`; iOS: `ios/UrBudget/Screens/Assistant/AssistantProposalCard.swift`, with
`AssistantController.swift`):

- For a card whose status is `proposed` and whose `card.rows` have a `key`: a checkbox or toggle
  per keyed row, on when it's applied. A row with `skipped: true` is dimmed with its label struck
  through; a row with `edited: true` shows its amount in the accent colour.
- Rows whose `edit` has `category` or `amount` get an edit button that opens a sheet (iOS) or
  dialog (Android): the app's category picker (`edit.categoryId` is the current choice; absent is
  Ready to Assign) and/or an amount field prefilled with the row's signed `amount`. An amount typed
  without a sign keeps the row's sign.
- Each toggle or save calls `assistant_revise` with `{ threadId, proposalId, revision }` (and the
  budget/patch handling the phone already uses for `assistant_apply`), then shows the proposal it
  returns. `revision` is `{ skip: [keys], set: [{ key, category?: id or null, amount?: cents }] }`,
  built from the card's current `choices`: turning a row off adds its key to `skip`; turning it on
  removes it from `skip` and drops any `set` entry for it with `amount: 0`; an edit replaces that
  key's `set` entry.
- The apply button reads "Apply n of m" when some keyed rows are left out, and is disabled at none.
  With `choices` present, offer "Use the assistant's version" (an empty revision).

The desktop's `desktop/src/assistant/ProposalCard.tsx` and `ProposalCard.test.tsx` are the
reference for behaviour and wording.

**Done when** both phones can leave rows out, change a category or an amount, show "Apply n of m"
and apply; Android unit tests pass (`gradlew :app:testDebugUnitTest`); iOS has unit tests in
`ios/UrBudgetTests` for building revisions and builds on CI (iOS can't be built on Windows); and
the changelog entry for this feature drops "For now this is on the desktop".
