import type { CreditPack } from "./api";
import { packBonus, packOffer } from "./money";

/**
 * One credit pack's Buy button: the price, and under it what the pack adds
 * ("→ $27.50 of credit") when it adds more than it costs. A pack from an older
 * server, or with no bonus, is the price alone, as it always was.
 */
export function PackButton({
  pack,
  disabled,
  onBuy,
}: {
  pack: CreditPack;
  disabled?: boolean;
  onBuy: () => void;
}) {
  const bonus = packBonus(pack);
  return (
    <button
      className={bonus ? "primary pack" : "primary"}
      disabled={disabled}
      title={bonus ? packOffer(pack) : undefined}
      onClick={onBuy}
    >
      {bonus ? (
        <>
          <span>Buy {pack.name}</span>
          <span className="packBonus">
            <span aria-hidden="true">→ </span>
            {bonus}
          </span>
        </>
      ) : (
        <>Buy {pack.name}</>
      )}
    </button>
  );
}
