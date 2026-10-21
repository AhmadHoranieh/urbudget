import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { Updates } from "./updates";

const percent = (share: number | null) =>
  share === null ? "" : ` ${Math.round(share * 100)}%`;

/** In the title bar while a newer version is waiting; opens Settings › General. */
export function UpdateChip({
  updates,
  onOpen,
}: {
  updates: Updates;
  onOpen: () => void;
}) {
  if (!updates.available) return null;
  const busy =
    updates.phase === "downloading" || updates.phase === "installing";
  return (
    <button
      className="update-chip"
      title={
        updates.available.version
          ? `Update available: version ${updates.available.version}`
          : "Update available from Microsoft Store"
      }
      onClick={onOpen}
    >
      {busy ? (
        <LoaderCircle size={13} className="spin" />
      ) : (
        <Download size={13} />
      )}
      <span className="header-label">
        {updates.phase === "downloading"
          ? `Downloading${percent(updates.progress)}`
          : "Update"}
      </span>
    </button>
  );
}

/** Settings › General: the version running, and a newer one to install. */
export function UpdateSetting({
  updates,
  version,
  onInstall,
}: {
  updates: Updates;
  version: string;
  onInstall: () => void;
}) {
  const { available, phase } = updates;
  return (
    <div className="setting-row update-setting">
      <span>
        <strong>
          {available
            ? available.version
              ? `Update available: version ${available.version}`
              : "Update available from Microsoft Store"
            : "Updates"}
        </strong>
        {available ? (
          <small className="update-notes">
            {available.notes ||
              "Installing saves your budget first, then UrBudget restarts."}
          </small>
        ) : (
          <small>
            {version && `You have version ${version}. `}
            {updates.channel === "microsoftStore"
              ? `${updates.current ? "Microsoft Store reports no updates available for this copy. " : ""}UrBudget checks the Store at launch and daily. You can also check and install updates here.`
              : `${updates.current ? "You're up to date. " : ""}UrBudget looks for updates when it starts and once a day, and installs one only when you choose.`}
          </small>
        )}
        {updates.error && <small className="form-error">{updates.error}</small>}
      </span>
      <div className="update-actions">
        {available ? (
          <button
            className="primary"
            disabled={phase !== "idle"}
            onClick={onInstall}
          >
            {phase === "idle" ? (
              <Download size={14} />
            ) : (
              <LoaderCircle size={14} className="spin" />
            )}
            {phase === "downloading"
              ? `Downloading${percent(updates.progress)}`
              : phase === "installing"
                ? "Installing…"
                : updates.channel === "microsoftStore"
                  ? "Install Store update"
                  : "Install & restart"}
          </button>
        ) : (
          <button
            className="secondary"
            disabled={phase !== "idle"}
            onClick={() => void updates.check(true)}
          >
            {phase === "checking" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {phase === "checking" ? "Checking…" : "Check now"}
          </button>
        )}
        {updates.channel === "microsoftStore" && (
          <button
            className="secondary"
            disabled={phase !== "idle"}
            onClick={() => void updates.openStore()}
          >
            Open Microsoft Store
          </button>
        )}
      </div>
    </div>
  );
}
