/**
 * Session list, newest activity first.
 *
 * A row tagged LIVE is a self-reported snapshot from a running session, and its most recent
 * activity is within the last few minutes. The provenance part (`provisional`) says the
 * numbers came from the extension rather than a file scan; the recency part is what makes
 * the tag mean "this session is running now", which matters in a deployment where the
 * server never scans files and every row is push-sourced.
 *
 * Tokens are shown as a total with the four kinds spelled out under it. `totalTokens` is
 * input + output + cache reads + cache writes, and cache reads dominate it, because every
 * model call reports the cached prefix it re-read. A session that cost $13.73 can show 113M
 * tokens of which 112M are cache reads, so the bare total is not comparable to the cost.
 */

import { formatTokens, formatCostSmart, shortProject, tokenKinds } from "../api.js";

/** Minutes of recent activity for a session to be tagged live. @type {number} */
const LIVE_WINDOW_MINUTES = 15;

/**
 * Whether a session's last activity is inside the live window.
 * @param {string | null} lastActivityAt ISO timestamp, as the API returns it
 * @returns {boolean}
 */
const isActiveNow = (lastActivityAt) => {
  if (!lastActivityAt) return false;
  const then = Date.parse(lastActivityAt);
  if (Number.isNaN(then)) return false;
  const ageMinutes = (Date.now() - then) / 60000;
  return ageMinutes >= 0 && ageMinutes <= LIVE_WINDOW_MINUTES;
};

/**
 * @param {{
 *   result: { total: number, limit: number, offset: number, sessions: object[] } | null,
 *   onPrev: () => void,
 *   onNext: () => void,
 * }} props
 * @returns {JSX.Element}
 */
export const SessionTable = ({ result, onPrev, onNext }) => {
  const sessions = result?.sessions ?? [];
  const offset = result?.offset ?? 0;
  const limit = result?.limit ?? 25;
  const total = result?.total ?? 0;
  const hasNext = offset + limit < total;

  return (
    <>
      <table className="sessions">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col" className="hide-narrow">
              Project
            </th>
            <th scope="col" className="hide-narrow">
              Last activity
            </th>
            <th scope="col" className="numeric">
              <span title="input + output + cache reads + cache writes. Cache reads are counted again on every model call, so they dominate long sessions and are usually priced far below input.">
                Total tokens
              </span>
            </th>
            <th scope="col" className="numeric">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.sessionId}>
              <td>
                <span className="session-name">
                  {session.name ?? session.sessionId.slice(0, 8)}
                  {session.provisional && isActiveNow(session.lastActivityAt) && (
                    <span className="live-tag" title="Self-reported by a running session">
                      live
                    </span>
                  )}
                  {session.isSubagent && (
                    <span
                      className="subagent-tag"
                      title="Nested session. Pi bills this work here and again as its parent session's tool-result usage."
                    >
                      subagent
                    </span>
                  )}
                </span>
              </td>
              <td className="hide-narrow">
                <span className="session-project">{shortProject(session.cwd)}</span>
              </td>
              <td className="hide-narrow numeral">{session.lastActivityAt?.slice(0, 16).replace("T", " ")}Z</td>
              <td className="numeric numeral">
                <span className="token-total" title={tokenKinds(session)}>
                  {formatTokens(session.totalTokens)}
                </span>
                <span className="token-kinds">{tokenKinds(session)}</span>
              </td>
              <td className="cost numeral">
                {session.costMicros === 0 ? "—" : formatCostSmart(session.costMicros)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button type="button" className="ghost" onClick={onPrev} disabled={offset === 0}>
          Newer
        </button>
        <button type="button" className="ghost" onClick={onNext} disabled={!hasNext}>
          Older
        </button>
        <span className="numeral">
          {total === 0 ? "no sessions" : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
        </span>
      </div>
    </>
  );
};
