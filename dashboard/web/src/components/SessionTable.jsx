/**
 * Session list, newest activity first.
 *
 * A row tagged LIVE came from a running session's self-report and is provisional: the
 * next scan rewrites it from the session file. The tag exists so a live number is never
 * mistaken for a settled one.
 */

import { formatCost, formatTokens, shortProject } from "../api.js";

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
              Tokens
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
                  {session.provisional && <span className="live-tag">live</span>}
                </span>
              </td>
              <td className="hide-narrow">
                <span className="session-project">{shortProject(session.cwd)}</span>
              </td>
              <td className="hide-narrow numeral">{session.lastActivityAt?.slice(0, 16).replace("T", " ")}Z</td>
              <td className="numeric numeral">{formatTokens(session.totalTokens)}</td>
              <td className="cost numeral">
                {session.costMicros === 0 ? "—" : formatCost(session.costMicros, session.costMicros < 10000 ? 4 : 2)}
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
