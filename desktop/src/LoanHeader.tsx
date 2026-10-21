import { useMemo } from "react";
import { ChartSpline, HandCoins, Landmark } from "lucide-react";
import { accountType, isLoanType, typeName } from "./accounts";
import { money, monthName } from "./format";
import {
  loanTerms,
  nextPayment,
  owedOn,
  percent,
  rateIn,
  useLoanActions,
  useProjection,
  type Projection,
} from "./Planning";
import { today, type Account, type Budget, type Category, type LoanTerms } from "./types";
import "./loans.css";

const payoff = (owed: number, plan: Projection) =>
  owed === 0 ? "Paid off" : plan.projection ? monthName(plan.projection.payoffDate.slice(0, 7), "short") : "—";

/**
 * Where a loan stands, over its register: what's owed, the rate and payment, when it's paid
 * off and the interest still to pay, with buttons to record a payment and plan paying it off.
 * A debt account without loan details asks for them instead.
 */
export function LoanHeader({ budget, account, balance }: { budget: Budget; account: Account; balance: number }) {
  const actions = useLoanActions();
  const terms = loanTerms(budget, account.id);
  const type = accountType(account, balance);
  const loanType = account.kind === "tracking" && isLoanType(type);
  const owed = owedOn(balance);
  const start = useMemo(() => nextPayment(budget, account.id), [budget.transactions, account.id]);
  const plan = useProjection(owed, terms, start);
  if (!terms) {
    if (!loanType || account.archived || !actions) return null;
    return (
      <div className="loan-header loan-prompt">
        <Landmark size={18} aria-hidden />
        <p>
          <strong>When will it be paid off?</strong>
          <span>Add the interest rate and monthly payment to see the payoff date and the interest left to pay.</span>
        </p>
        <button className="secondary" onClick={() => actions.details(account)}>
          Add loan details
        </button>
      </div>
    );
  }
  const fees = type === "mortgage" ? "escrow" : "fees";
  return (
    <section className="loan-header" aria-label="Loan">
      <dl className="loan-facts">
        <div>
          <dt>Owed</dt>
          <dd>{money(owed)}</dd>
        </div>
        <div>
          <dt>Rate</dt>
          <dd>{percent(rateIn(terms, today().slice(0, 7)))}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{money(terms.monthlyPayment)}</dd>
        </div>
        <div>
          <dt>Paid off</dt>
          <dd>{payoff(owed, plan)}</dd>
        </div>
        <div>
          <dt>Interest to pay</dt>
          <dd>{plan.projection ? money(plan.projection.totalInterest) : owed ? "—" : money(0)}</dd>
        </div>
      </dl>
      {actions && owed > 0 && (
        <div className="loan-actions">
          {!account.archived && (
            <button className="primary" onClick={() => actions.record(account)}>
              <HandCoins size={15} aria-hidden /> Record payment
            </button>
          )}
          <button className="secondary" onClick={() => actions.plan(account)}>
            <ChartSpline size={15} aria-hidden /> Payoff planner
          </button>
        </div>
      )}
      <p className="loan-note">
        {plan.error ? (
          <span className="warning-text">{plan.error}</span>
        ) : (
          <span>
            {terms.monthlyFees ? `Interest and ${fees} are` : "Interest is"} added to the loan with the first payment
            each month.
          </span>
        )}
        {actions && (
          <button className="link-button" onClick={() => actions.details(account)}>
            Edit loan details
          </button>
        )}
      </p>
      {!loanType && (
        <p className="loan-note">
          <span>
            This account is set as {typeName(type).toLowerCase()}. Change its type to a loan, such as Personal loan, to
            list it with your debts.
          </span>
        </p>
      )}
    </section>
  );
}

function CategoryLoan({
  budget,
  category,
  terms,
  account,
  balance,
  edit,
  onSaved,
}: {
  budget: Budget;
  category: Category;
  terms: LoanTerms;
  account: Account;
  balance: number;
  edit: (fn: (b: Budget) => void) => void;
  onSaved: (message: string) => void;
}) {
  const actions = useLoanActions();
  const owed = owedOn(balance);
  const start = useMemo(() => nextPayment(budget, account.id), [budget.transactions, account.id]);
  const plan = useProjection(owed, terms, start);
  const targeted = category.target === terms.monthlyPayment && category.goal?.goal_type === "DEBT";
  // A monthly debt payment target (TargetFields' "Monthly debt payment"), as the target editor saves one.
  const useAsTarget = () => {
    edit((d) => {
      const c = d.categories.find((x) => x.id === category.id);
      if (!c) return;
      const goal = c.goal?.goal_type === "DEBT" ? c.goal : { goal_creation_month: `${today().slice(0, 7)}-01` };
      c.target = terms.monthlyPayment;
      c.goal = { ...goal, goal_type: "DEBT", goal_needs_whole_amount: null, goal_target: terms.monthlyPayment * 10 };
    });
    onSaved(`Set ${category.name}'s target to the ${money(terms.monthlyPayment)} ${account.name} payment.`);
  };
  return (
    <section className="loan-category" aria-label={`${account.name} loan`}>
      <h3>
        <Landmark size={13} aria-hidden /> Pays {account.name}
      </h3>
      <dl className="detail-list">
        <div>
          <dt>Still owed</dt>
          <dd>{money(owed)}</dd>
        </div>
        <div>
          <dt>Paid off</dt>
          <dd>{payoff(owed, plan)}</dd>
        </div>
        <div>
          <dt>Monthly payment</dt>
          <dd>{money(terms.monthlyPayment)}</dd>
        </div>
      </dl>
      {actions && (
        <div className="button-row">
          {!account.archived && owed > 0 && (
            <button className="primary" onClick={() => actions.record(account)}>
              <HandCoins size={15} aria-hidden /> Record payment
            </button>
          )}
          {owed > 0 && (
            <button className="secondary" onClick={() => actions.plan(account)}>
              Open planner
            </button>
          )}
        </div>
      )}
      {!targeted && (
        <button className="link-button" onClick={useAsTarget}>
          Use this payment as target
        </button>
      )}
    </section>
  );
}

/** A loan's payment category, in the budget's inspector: the loans it pays and their actions. */
export function CategoryLoans({
  budget,
  category,
  balances,
  edit,
  onSaved,
}: {
  budget: Budget;
  category: Category;
  balances: Map<string, number>;
  edit: (fn: (b: Budget) => void) => void;
  onSaved: (message: string) => void;
}) {
  const loans = (budget.loans ?? []).flatMap((terms) => {
    const account = terms.categoryId === category.id && budget.accounts.find((a) => a.id === terms.accountId);
    return account ? [{ terms, account }] : [];
  });
  return loans.map(({ terms, account }) => (
    <CategoryLoan
      key={account.id}
      budget={budget}
      category={category}
      terms={terms}
      account={account}
      balance={balances.get(account.id) ?? account.openingBalance}
      edit={edit}
      onSaved={onSaved}
    />
  ));
}
