/**
 * Spend by provider and model, as a ledger list with proportional bars.
 *
 * This panel answers where the money went. Models priced at zero are listed too, with
 * their token count, because on a machine running local models "this one is free" is a
 * useful fact, not an absence.
 */

import { formatCost, formatTokens } from "../api.js";

/**
 * @param {{ models: { provider: string, modelId: string, costMicros: number, totalTokens: number, events: number }[] }} props
 * @returns {JSX.Element}
 */
export const ModelBreakdown = ({ models }) => {
  const top = models.slice(0, 12);
  const maxCost = top.reduce((max, model) => Math.max(max, model.costMicros), 0);

  return (
    <ul className="ledger">
      {top.map((model) => (
        <li className="ledger-row" key={`${model.provider}/${model.modelId}`}>
          <span className="name">
            {model.modelId ?? "unspecified"}
            <span className="session-project"> · {model.provider ?? "unknown provider"}</span>
          </span>
          <span className="amount numeral">
            {model.costMicros === 0 ? "free" : formatCost(model.costMicros, model.costMicros < 10000 ? 4 : 2)}
          </span>
          <span
            className="meta numeral"
            title={`cache read ${formatTokens(model.cacheReadTokens ?? 0)} · output ${formatTokens(
              model.outputTokens ?? 0,
            )} · input ${formatTokens(model.inputTokens ?? 0)}`}
          >
            {formatTokens(model.totalTokens)} tok
          </span>
          <span className="bar-track" aria-hidden="true">
            <span
              className="bar-fill"
              style={{ width: `${maxCost > 0 ? (model.costMicros / maxCost) * 100 : 0}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
};
