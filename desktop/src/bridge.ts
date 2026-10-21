import { invoke, isTauri } from "@tauri-apps/api/core";
import { apply, diff, type Patch } from "./patch";
import { getPref } from "./prefs";
import type {
  Budget,
  DatabaseStatus,
  Snapshot,
  Summary,
  ImportResult,
  LoanTerms,
  LoanProjection,
  Transaction,
  SavedYnabToken,
  YnabImportRequest,
  YnabPlan,
} from "./types";
export const desktop = isTauri();

// Rust holds a draft of the budget. `synced` is the budget object that draft
// matches; calls send the difference between their budget and `synced`, so an
// edit transfers only the records it touched. Every call goes through one queue,
// keeping patches, saves and reads in order. When the draft's state is unknown
// (a reset failed), the next call sends the complete budget once.
let synced: Budget | null = null;
let tail: Promise<unknown> = Promise.resolve();
function queue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => {});
  return run;
}
async function relative(budget: Budget): Promise<Patch | null> {
  if (!synced) {
    await invoke("replace_draft", { budget });
    synced = budget;
  }
  return diff(synced, budget);
}
/** Obsolete queued reads never reach Rust. An already-running command still completes before
 * the queue advances, preserving the order of draft changes and saves. */
export const read = <T>(budget: Budget, command: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
  queue(async () => {
    signal?.throwIfAborted();
    const patch = await relative(budget);
    signal?.throwIfAborted();
    const result = await invoke<T>(command, { ...args, patch });
    signal?.throwIfAborted();
    return result;
  });
/** Runs a command that returns a patch, and applies it to `budget`. For feature modules. */
export const change = (budget: Budget, command: string, args: Record<string, unknown>) =>
  queue(async () => {
    const patch = await invoke<Patch>(command, {
      ...args,
      patch: await relative(budget),
    });
    return apply(budget, patch);
  });
/** Runs a command that replaces the draft with the budget it returns. */
export const reset = <T>(command: string, args: Record<string, unknown>, budget: (r: T) => Budget | null) =>
  queue(async () => {
    try {
      const result = await invoke<T>(command, args);
      synced = budget(result) ?? synced;
      return result;
    } catch (e) {
      synced = null;
      throw e;
    }
  });

export type Applied = { recoveryError?: string | null };
export type CalculationOptions = { asOfMonth?: string; signal?: AbortSignal };
export const api = {
  load: () => reset<Snapshot>("load_budget", { legacyBackupKeep: getPref("keepBackups") }, (s) => s.budget),
  /** Makes `budget` the draft. Rust writes the unsaved changes to its recovery file. */
  push: (budget: Budget) =>
    queue(async (): Promise<Applied> => {
      if (synced && budget === synced) return {};
      try {
        const patch = await relative(budget);
        const result = patch ? await invoke<Applied>("apply_patch", { patch }) : {};
        synced = budget;
        return result;
      } catch {
        // Fall back to sending everything; Rust's draft becomes exactly `budget`.
        const result = await invoke<Applied>("replace_draft", { budget });
        synced = budget;
        return result;
      }
    }),
  /** Saves the draft, writing only rows that changed since the last save. */
  commit: (expectedToken: string) =>
    queue(() => invoke<DatabaseStatus>("commit_budget", { expectedToken })),
  status: () => invoke<DatabaseStatus>("database_status"),
  calculate: (budget: Budget, month: string, options: CalculationOptions = {}) =>
    read<Summary>(budget, "calculate_budget", { month, asOfMonth: options.asOfMonth }, options.signal),
  validate: (budget: Budget) => read<void>(budget, "validate_budget"),
  recoveryRead: () =>
    invoke<{ budget: Budget; matches: boolean } | null>("read_recovery"),
  discardRecovery: () => invoke<void>("discard_recovery"),
  runSchedules: (expectedToken: string, through: string) =>
    reset<Snapshot>("run_schedules", { expectedToken, through }, (s) => s.budget),
  syncYnab: ({ token, planId, replace, remember, savedToken, tokenLabel }: YnabImportRequest, expectedToken: string) =>
    reset<ImportResult>(
      "sync_ynab",
      {
        token,
        planId,
        expectedToken,
        replace,
        rememberToken: !!remember,
        tokenLabel: tokenLabel ?? null,
        savedToken: savedToken ?? null,
      },
      // A review leaves the saved budget, which the window already shows.
      (r) => (r.reviewId ? null : r.snapshot.budget),
    ),
  /** Saves an import whose totals differ from YNAB's, once the person has seen them. */
  acceptYnab: (reviewId: string, expectedToken: string) =>
    reset<ImportResult>("accept_ynab_import", { reviewId, expectedToken }, (r) => (r.reviewId ? null : r.snapshot.budget)),
  resolveYnab: (
    reviewId: string,
    choices: Record<string, string>,
    expectedToken: string,
  ) =>
    reset<ImportResult>(
      "resolve_ynab",
      { reviewId, choices, expectedToken },
      (r) => r.snapshot.budget,
    ),
  /** The plans a YNAB token can read, most recently edited first. */
  ynabPlans: (token: string, savedToken?: string) =>
    invoke<YnabPlan[]>("ynab_plans", { token, savedToken: savedToken ?? null }),
  /** YNAB tokens kept on this device, most recently used first. */
  ynabTokens: () => invoke<SavedYnabToken[]>("ynab_tokens"),
  forgetToken: (id: string) => invoke<void>("forget_ynab_token", { id }),
  listBudgets: () => invoke<BudgetListing[]>("list_budgets"),
  /** Saves a new budget file; the open budget is unchanged. Returns its id. */
  createBudget: (budget: Budget, source?: { budget: Budget; token: string }) => source
    ? read<string>(source.budget, "create_budget", { budget, freshStartToken: source.token })
    : invoke<string>("create_budget", { budget }),
  /** Switches the window to another budget (save the open one first). */
  openBudget: (id: string) => reset<Snapshot>("open_budget", { id }, (s) => s.budget),
  deleteBudget: (id: string) => invoke<BudgetListing[]>("delete_budget", { id }),
  /** Shows a file from the app's data folder in the system file manager. */
  reveal: (path: string) => invoke<void>("reveal_path", { path }),
  importYnab: (exportData: unknown) =>
    invoke<Budget>("import_ynab_export", { exportData }),
  /**
   * A new, unsaved budget from YNAB's own export (its .zip, or the Register and Plan CSVs).
   * `dateOrder` is "dmy", "mdy" or "ymd", or null to detect it; `currency` applies when the
   * amounts carry no symbol.
   */
  importYnabFiles: (files: { name: string; bytes: number[] }[], dateOrder: string | null, currency: string) =>
    invoke<Budget>("import_ynab_files", { files, dateOrder, currency }),
  backup: () => invoke<string>("backup_database"),
  backupRetention: () => invoke<number>("backup_retention"),
  setBackupRetention: (keep: number) => invoke<void>("set_backup_retention", { keep }),
  restoreBackup: (budget: Budget, expectedToken: string) =>
    reset<Snapshot>("restore_budget", { budget, expectedToken }, (s) => s.budget),
  /** Deletes all but the newest `keep` backups. */
  pruneBackups: (keep: number) => invoke<number>("prune_backups", { keep }),
  export: (budget: Budget) => read<string>(budget, "export_budget"),
  /** Preserve an invalid unsaved draft for repair; ordinary backup exports still validate. */
  exportRecoveryDraft: (budget: Budget) => read<string>(budget, "export_budget", { recovery: true }),
  exportYnab: (budget: Budget) => read<string>(budget, "export_ynab_csv"),
  /** One account's transactions (or all), optionally just the listed ones, as a register CSV. */
  exportTransactions: (budget: Budget, accountId: string | null, ids: string[] | null) =>
    read<string>(budget, "export_transactions", { accountId, ids }),
  /** Saves a CSV the app made (a template) in the budget's exports folder. */
  writeExport: (name: string, contents: string) => invoke<string>("write_export", { name, contents }),
  upsertTransaction: (budget: Budget, transaction: Transaction) =>
    change(budget, "upsert_transaction", { transaction }),
  sourceLoanTerms: (budget: Budget, accountId: string) =>
    read<LoanTerms>(budget, "source_loan_terms", { accountId }),
  previewBank: (
    budget: Budget,
    account: string,
    content: string,
    format: string,
    dateFormat: string,
    /** For a CSV whose one Amount column writes purchases as positive numbers. */
    flipSigns: boolean,
  ) =>
    read<BankRow[]>(budget, "preview_bank_file", {
      account,
      content,
      format,
      dateFormat,
      flipSigns,
    }),
  importBank: (
    budget: Budget,
    account: string,
    choices: { row: BankRow; action: string; matchId: string | null }[],
  ) => change(budget, "import_bank_file", { account, choices }),
  action: (budget: Budget, action: Record<string, unknown>) =>
    change(budget, "budget_action", { action }),
  /**
   * What every quick-assign option would change for these categories, in one call: per option,
   * the categories whose Assigned changes, or null for an option that can't run.
   */
  autoAssignPreview: (budget: Budget, month: string, categories: string[], limitToAvailable: boolean, options: CalculationOptions = {}) =>
    read<Record<string, { id: string; before: number; after: number }[] | null>>(budget, "auto_assign_preview", {
      month,
      categories,
      limitToAvailable,
      asOfMonth: options.asOfMonth,
    }, options.signal),
  /** The actual summary after applying one option to an ephemeral native snapshot. */
  autoAssignResult: (budget: Budget, month: string, mode: string, categories: string[], limitToAvailable: boolean, options: CalculationOptions = {}) =>
    read<Summary>(budget, "preview_auto_assign_result", { month, mode, categories, limitToAvailable, asOfMonth: options.asOfMonth }, options.signal),
  reports: (budget: Budget, filter: ReportFilter, signal?: AbortSignal) =>
    read<Report>(budget, "calculate_reports", { filter }, signal),
  exportReports: (budget: Budget, filter: ReportFilter) =>
    read<string>(budget, "export_reports", { filter }),
  previewSchedules: (
    budget: Budget,
    through: string,
    selected: string | null,
    skip: boolean,
  ) => change(budget, "preview_schedules", { through, selected, skip }),
  /** `lump` is a one-off paid with the first payment, after that month's interest and fees. */
  projectLoan: (
    balance: number,
    terms: LoanTerms,
    start: string,
    extra: number,
    lump = 0,
  ) => invoke<LoanProjection>("project_loan", { balance, terms, start, extra, lump }),
  loanPaymentByDate: (
    balance: number,
    terms: LoanTerms,
    start: string,
    due: string,
    lump = 0,
  ) => invoke<number>("loan_payment_by_date", { balance, terms, start, due, lump }),
  recordLoanPayment: (
    budget: Budget,
    terms: LoanTerms,
    from: string,
    amount: number,
    date: string,
    id: string,
  ) =>
    change(budget, "record_loan_payment", { terms, from, amount, date, id }),
  reconcile: (
    budget: Budget,
    accountId: string,
    balance: number,
    date: string,
    adjustmentId: string,
  ) =>
    change(budget, "reconcile_budget", {
      accountId,
      balance,
      date,
      adjustmentId,
    }),
};

export type BudgetListing = {
  id: string;
  name: string;
  currency: string;
  current: boolean;
  lastOpened: string | null;
  path: string;
  missing: boolean;
};

export type ReportFilter = {
  from: string;
  to: string;
  accountIds: string[];
  categoryIds: string[];
};
export type Report = {
  months: {
    month: string;
    income: number;
    spending: number;
    netIncome: number;
    assets: number;
    debt: number;
    netWorth: number;
    categories: Record<string, number>;
    incomeSources: Record<string, number>;
    accounts: Record<string, number>;
  }[];
  categories: Record<string, number>;
  incomeSources: Record<string, number>;
  income: number;
  spending: number;
  ageOfMoney: number | null;
};

export type BankRow = {
  id: string;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  duplicate: boolean;
  candidates: string[];
  previouslyMatchedCandidates?: string[];
  candidateDetails?: { id: string; transactionId: string; splitIndex: number }[];
  idless?: boolean;
  possibleDuplicate?: boolean;
  groupId?: string;
  /** A stable ID for a deliberately separate, otherwise identical ID-less transaction. */
  importId?: string;
  /** The payee a rule gives the row, when it differs from the bank's. */
  rename?: string;
  /** The category the payee rules give it. */
  categoryId?: string;
  /** When the bank says it happened (bank sync), which becomes its createdAt; a file has none. */
  at?: string;
};
