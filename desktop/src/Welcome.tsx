// What someone sees before their budget has anything in it, the sample budget's banner, and the
// getting-started checklist that walks a new budget through the method.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, FileArchive, FlaskConical, Sprout, X } from "lucide-react";
import { api } from "./bridge";
import { BudgetFormatFields, type FormatValue } from "./BudgetFormatFields";
import { YnabFileImport } from "./YnabFileImport";
import { YnabImport } from "./YnabImport";
import { demoBudget } from "./demo";
import { errorText, numberFormatFor } from "./format";
import { starterCategories } from "./newBudget";
import { useToast } from "./ui";
import type { Budget, ImportResult, YnabImportRequest } from "./types";
import "./welcome.css";

/** The currency a first launch's budget is made with (Budget::default in domain.rs). */
const BUILT_IN_CURRENCY = "SAR";
const SAMPLE_NAME = "Sample budget";

/** No accounts, categories or transactions: a budget nobody has set up yet. */
export const isBlank = (b: Budget) => !b.accounts.length && !b.categories.length && !b.transactions.length;

/** A first launch's empty budget, still in the built-in currency and formats nobody chose. */
export const isUntouched = (b: Budget) =>
  isBlank(b) && !b.assignments.length && b.currency === BUILT_IN_CURRENCY && !b.numberFormat && !b.dateFormat;

/** Whether a budget shows the getting-started checklist: "on" once it was set up from the welcome screen. */
const setupKey = (budgetId: string) => `lb:setup:${budgetId}`;
const readSetup = (budgetId: string) => {
  try {
    return localStorage.getItem(setupKey(budgetId));
  } catch {
    return null;
  }
};
const writeSetup = (budgetId: string, value: "on" | "off") => {
  try {
    localStorage.setItem(setupKey(budgetId), value);
  } catch {
    // Without storage the checklist shows until the app closes.
  }
};

/** Opens the sample budget, making it (in this budget's currency and formats) the first time. */
export async function openSample(budget: Budget, budgetId: string, openBudget: (id: string) => Promise<void>) {
  const existing = (await api.listBudgets()).find((b) => b.name === SAMPLE_NAME && !b.missing);
  const id =
    existing?.id ??
    (await api.createBudget({
      ...demoBudget(),
      name: SAMPLE_NAME,
      currency: budget.currency,
      numberFormat: budget.numberFormat,
      dateFormat: budget.dateFormat,
      sample: { from: budgetId },
    }));
  await openBudget(id);
}

type Path = "ynab" | "fresh";

/** Three ways into an empty budget: bring it over from YNAB, start from starter categories, or look around a sample. */
export function Welcome({
  budget,
  budgetId,
  edit,
  transform,
  openBudget,
  onAddAccount,
  importYnab,
  acceptYnab,
  resolveYnab,
  onAsk,
}: {
  budget: Budget;
  budgetId: string;
  edit: (update: (draft: Budget) => void) => void;
  transform: (work: (b: Budget) => Promise<Budget>) => Promise<void>;
  /** Switches to another budget (saving this one first). */
  openBudget: (id: string) => Promise<void>;
  onAddAccount: () => void;
  /** YNAB's API import into this budget, as Settings › Import runs it. */
  importYnab: (request: YnabImportRequest) => Promise<ImportResult>;
  acceptYnab: (reviewId: string) => Promise<ImportResult>;
  resolveYnab: (id: string, choices: Record<string, string>) => Promise<ImportResult>;
  /** Opens the assistant with a question. */
  onAsk?: (text: string) => void;
}) {
  const toast = useToast();
  const [path, setPath] = useState<Path | null>(null);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<FormatValue>(() => ({
    currency: budget.currency,
    numberFormat: numberFormatFor(budget.currency, budget.numberFormat),
    dateFormat: budget.dateFormat ?? "iso",
  }));
  const [starter, setStarter] = useState(true);
  const [exportFile, setExportFile] = useState(false);
  // A budget set up from here gets the checklist, unless it was hidden before.
  useEffect(() => {
    if (budgetId && !readSetup(budgetId)) writeSetup(budgetId, "on");
  }, [budgetId]);

  const options: { id: Path | "sample"; icon: ReactNode; title: string; text: string }[] = [
    {
      id: "ynab",
      icon: <FileArchive size={20} />,
      title: "I'm coming from YNAB",
      text: "Paste a YNAB token and bring everything over in one click, checked against YNAB's own numbers.",
    },
    {
      id: "fresh",
      icon: <Sprout size={20} />,
      title: "Start fresh",
      text: "Start with categories for bills, needs, wants and savings, then add your accounts.",
    },
    {
      id: "sample",
      icon: <FlaskConical size={20} />,
      title: "Look around first",
      text: "Open a sample budget to try things out. This budget stays empty until you're ready.",
    },
  ];
  const choose = async (id: Path | "sample") => {
    if (id !== "sample") return setPath(path === id ? null : id);
    setBusy(true);
    try {
      await openSample(budget, budgetId, openBudget);
    } catch (e) {
      toast({ message: errorText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page welcome">
      <div className="welcome-intro">
        <h2>Let's set up your budget</h2>
        <p>
          UrBudget works like envelopes: you give all the money you have a job, spend from those jobs, and move money
          around when life changes the plan. How would you like to start?
        </p>
      </div>
      <ul className="welcome-paths">
        {options.map((o) => (
          <li key={o.id}>
            <button
              className={`welcome-path${path === o.id ? " selected" : ""}`}
              aria-expanded={o.id === "sample" ? undefined : path === o.id}
              disabled={busy}
              onClick={() => void choose(o.id)}
            >
              <span className="welcome-icon">{o.icon}</span>
              <strong>{o.title}</strong>
              <small>{o.text}</small>
              <ArrowRight size={15} className="welcome-arrow" />
            </button>
          </li>
        ))}
      </ul>
      {path === "ynab" && (
        <div className="welcome-step">
          {!exportFile && (
            <p className="help">
              Make a token in YNAB on the web (Account Settings, then Developer Settings, then New Token), paste it
              below, pick your plan and choose Import &amp; save.
            </p>
          )}
          {exportFile ? (
            <YnabFileImport
              budget={budget}
              openBudget={openBudget}
              onBudget={(imported) => transform(async () => imported)}
            />
          ) : (
            <YnabImport onImport={importYnab} onAccept={acceptYnab} onResolve={resolveYnab} onAsk={onAsk} blank />
          )}
          <p className="help">
            <button className="link-button" onClick={() => setExportFile(!exportFile)}>
              {exportFile ? "Use a YNAB token instead" : "No token? Use YNAB's export file"}
            </button>
            {!exportFile && " (it leaves out targets, notes and scheduled transactions)."}
          </p>
        </div>
      )}
      {path === "fresh" && (
        <form
          className="welcome-step panel"
          onSubmit={(e) => {
            e.preventDefault();
            edit((d) => {
              Object.assign(d, format);
              if (starter) Object.assign(d, starterCategories());
            });
            onAddAccount();
          }}
        >
          <h2>Start fresh</h2>
          <BudgetFormatFields value={format} onChange={setFormat} />
          <label className="checkbox-label">
            <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
            Start with categories for bills, needs, wants and savings (rename or delete any of them later)
          </label>
          <div className="modal-actions">
            <button className="primary">
              Next: add your accounts <ArrowRight size={15} />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Says the open budget is the sample, with ways back to a real one. */
export function SampleBanner({
  budget,
  budgetId,
  openBudget,
  onNewBudget,
}: {
  budget: Budget;
  budgetId: string;
  openBudget: (id: string) => Promise<void>;
  onNewBudget: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!budget.sample) return null;
  const leave = async (remove: boolean) => {
    setBusy(true);
    try {
      const others = (await api.listBudgets()).filter((b) => b.id !== budgetId && !b.missing);
      const target = others.find((b) => b.id === budget.sample?.from) ?? others[0];
      if (!target) return onNewBudget();
      await openBudget(target.id);
      if (remove) {
        await api.deleteBudget(budgetId);
        toast({ message: "Deleted the sample budget." });
      }
    } catch (e) {
      toast({ message: errorText(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice sample-banner" role="note">
      <FlaskConical size={16} />
      <span>
        <strong>This is a sample budget.</strong> Try anything here; your own budget is separate.
      </span>
      <button className="primary" disabled={busy} onClick={() => void leave(false)}>
        Go to my budget
      </button>
      <button className="secondary" disabled={busy} onClick={() => void leave(true)}>
        Delete sample
      </button>
    </div>
  );
}

type Step = { title: string; text: string; done: boolean; action?: [label: string, run: () => void] };

/**
 * Five steps that teach the method by doing it, each ticked off by what's in the budget. Shown for
 * budgets set up from the welcome screen until they're hidden.
 */
export function GettingStarted({
  budget,
  budgetId,
  onAddAccount,
  onAssign,
  onAddTransaction,
  onSetTarget,
}: {
  budget: Budget;
  budgetId: string;
  onAddAccount: () => void;
  onAssign: () => void;
  onAddTransaction?: () => void;
  onSetTarget: () => void;
}) {
  const [shown, setShown] = useState(() => readSetup(budgetId) === "on");
  const [chosen, setChosen] = useState<number | null>(null);
  useEffect(() => setShown(readSetup(budgetId) === "on"), [budgetId]);
  const steps: Step[] = [
    {
      title: "Add your accounts",
      text: "Add each bank account and credit card with today's balance. That balance is the money you have to budget.",
      done: budget.accounts.length > 0,
      action: ["Add an account", onAddAccount],
    },
    {
      title: "Assign your money",
      text: "Give all of it a job: type amounts in the Assigned column until Unassigned reaches zero. Quick assign on the right can fill in targets for you.",
      done: budget.assignments.some((a) => a.amount !== 0),
      action: ["Assign money", onAssign],
    },
    {
      title: "Record your spending",
      text: "Add transactions as you spend, or import the statement file your bank lets you download (CSV, OFX, QFX or QIF) from an account's page. Each one comes out of its category.",
      done: budget.transactions.length > 0,
      action: onAddTransaction && ["Add a transaction", onAddTransaction],
    },
    {
      title: "Plan for a bigger bill",
      text: "Pick something that doesn't come every month, like car insurance or gifts, and give it a target. UrBudget works out what to set aside each month so it's ready when it's due.",
      done: budget.categories.some((c) => c.target > 0 || !!c.goal),
      action: ["Set a target", onSetTarget],
    },
    {
      title: "Cover overspending",
      text: "When a category's Available turns red, click the amount and move money over from a category that has some left. Changing the plan is part of the plan.",
      done: (budget.moneyMoves ?? []).some((m) => m.kind === "move" && (m.changes?.length ?? 0) > 1),
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  // When a step gets done, move on to the next one.
  useEffect(() => setChosen(null), [doneCount]);
  if (!shown || budget.sample || budget.importedFrom || budget.ynabPlanId) return null;
  const hide = () => {
    writeSetup(budgetId, "off");
    setShown(false);
  };
  const allDone = doneCount === steps.length;
  const open = chosen ?? steps.findIndex((s) => !s.done);
  const step = steps[open];
  return (
    <section className="getting-started" aria-label="Getting started">
      <div className="gs-head">
        <strong>Getting started</strong>
        <span className="gs-count">
          {doneCount} of {steps.length} done
        </span>
        <span className="gs-bar" aria-hidden>
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </span>
        <button className="icon-button" title="Hide getting started" aria-label="Hide getting started" onClick={hide}>
          <X size={15} />
        </button>
      </div>
      <ol className="gs-steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <button
              className={`gs-step${s.done ? " done" : ""}${i === open && !allDone ? " open" : ""}`}
              aria-current={i === open && !allDone ? "step" : undefined}
              onClick={() => setChosen(i)}
            >
              <span className="gs-mark">{s.done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              {s.title}
            </button>
          </li>
        ))}
      </ol>
      {allDone ? (
        <div className="gs-detail">
          <p>
            That's the method. From here it's a few minutes a week: record what you spent, and assign new money when it
            comes in.
          </p>
          <button className="secondary small" onClick={hide}>
            Hide this
          </button>
        </div>
      ) : (
        step && (
          <div className="gs-detail">
            <p>{step.text}</p>
            {step.action && !step.done && (
              <button className="secondary small" onClick={step.action[1]}>
                {step.action[0]}
              </button>
            )}
          </div>
        )
      )}
    </section>
  );
}
