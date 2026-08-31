import { memo } from "react";

/**
 * Provider balance chip (the "credit" button in the chat titlebar).
 *
 * Behavior:
 *   - Always visible: shows a "—" placeholder when `amount` is null, so the
 *     user can ALWAYS see + click the chip from the moment the app opens
 *     (previously it was hidden until a real /credits response arrived, which
 *     made the chip effectively invisible on first launch).
 *   - Click-to-refresh: the parent calls `fetchCredits`; this chip just shows
 *     a spinner while `busy` is true and is disabled during the in-flight
 *     request to prevent double-fires.
 *   - dir="ltr" + tabular-nums keep the digits aligned even when the UI is
 *     right-to-left.
 *
 * The chip is intentionally a pure presentational component so it can be
 * unit-tested without spinning up the whole ChatPanel.
 */
export interface BalanceChipProps {
  /** Provider display name (e.g. "OpenAI"). Used in the tooltip. */
  providerName: string | null;
  /** Current balance in USD, or null when not yet fetched. */
  amount: number | null;
  /** True while a refresh request is in flight (drives the spinner). */
  busy: boolean;
  /** Disables the button (also grays it out). */
  disabled?: boolean;
  /** Click handler — usually wires to `fetchCredits(provider)`. */
  onRefresh: () => void;
}

function BalanceChipImpl({
  providerName,
  amount,
  busy,
  disabled,
  onRefresh,
}: BalanceChipProps) {
  const hasBalance = typeof amount === "number";
  const tooltip = hasBalance
    ? `${providerName ?? "Provider"} balance — کلیک برای به‌روزرسانی`
    : providerName
      ? `${providerName} — کلیک برای دریافت موجودی`
      : "کلیک برای دریافت موجودی";

  return (
    <button
      type="button"
      data-testid="balance-chip"
      data-busy={busy ? "true" : "false"}
      data-has-balance={hasBalance ? "true" : "false"}
      className={`badge titlebar-balance titlebar-balance-clickable${
        busy ? " refreshing" : ""
      }`}
      title={tooltip}
      dir="ltr"
      disabled={disabled}
      onClick={onRefresh}
    >
      <svg
        className="titlebar-balance-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
      </svg>
      <span className="titlebar-balance-amount">
        {hasBalance ? `$${amount!.toFixed(2)}` : "—"}
      </span>
    </button>
  );
}

export const BalanceChip = memo(BalanceChipImpl);
