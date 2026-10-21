import { api } from "./bridge";
import { learnFromRename, ruleChanges } from "./bankNames";
import { errorText } from "./format";
import { useToast } from "./ui";
import { id, type Budget, type Transaction } from "./types";

type Transform = (fn: (b: Budget) => Promise<Budget>) => Promise<void>;

/**
 * Returns a function to call after a transaction is saved: when it came from a bank file and
 * was given a new payee, it offers to name that bank text the same way from now on, and then
 * to do the same to earlier transactions with it.
 */
export function useLearnPayee(transform: Transform, undo?: () => void) {
  const toast = useToast();
  const fail = (e: unknown) => toast({ message: errorText(e), tone: "error" });
  return (before: Budget, saved: Transaction) => {
    const learned = learnFromRename(before, saved);
    if (!learned) return;
    const rule = { ...learned, id: id() };
    const add = async () => {
      let others = 0;
      await transform(async (b) => {
        const next = { ...b, payeeRules: [...(b.payeeRules ?? []), rule] };
        others = ruleChanges(next, new Set([rule.id]));
        return next;
      });
      const reapply = () =>
        transform((b) => api.action(b, { type: "reapplyPayeeRules", ruleIds: [rule.id] })).then(
          () => toast({ message: `Updated ${others === 1 ? "1 transaction" : `${others.toLocaleString()} transactions`}.`, action: undo && { label: "Undo", onClick: undo } }),
          fail,
        );
      toast(
        others
          ? {
              message: `Rule added. Apply it to ${others === 1 ? "1 earlier transaction" : `${others.toLocaleString()} earlier transactions`} too?`,
              duration: 10000,
              action: { label: "Apply", onClick: () => void reapply() },
            }
          : { message: "Rule added.", action: undo && { label: "Undo", onClick: undo } },
      );
    };
    toast({
      message: `Always use ${rule.payee} for bank payees with “${rule.match}”?`,
      duration: 10000,
      action: { label: "Add rule", onClick: () => void add().catch(fail) },
    });
  };
}
