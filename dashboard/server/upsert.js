/**
 * Guarded session upsert, shared by the directory scanner and POST /api/ingest.
 *
 * Two writers touch the same row: the scanner, which reads the authoritative file, and
 * the extension, which snapshots a session that is still running. Rules from DESIGN.md §7:
 *
 *   - A scan always writes, because the file is the source of truth.
 *   - A push writes only when it is at least as fresh as what is stored, compared by
 *     `entry_count`. Without that guard an out-of-order push could lower a total.
 *   - Facts are replaced wholesale inside the same transaction, so ingest is idempotent
 *     and independent of arrival order.
 */

/**
 * Insert or update one session row and replace its usage facts.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {object} session Rollup from aggregateSession: sessionId, sessionFile,
 *   parentSessionId, cwd, name, startedAt, lastActivityAt, entryCount, costMicros,
 *   token counts, and message counts
 * @param {object[]} events Usage facts from aggregateSession, the complete set for the session
 * @param {"scan" | "push"} source Which writer is reporting
 * @returns {boolean} true when the row was written, false when a stale push was discarded
 */
export const upsertSession = (db, session, events, source) => {
  if (!session.sessionId) return false;

  const write = db.transaction(() => {
    const result = db
      .prepare(`
        INSERT INTO sessions (
          session_id, session_file, parent_session_id, parent_session_file, cwd, name, started_at,
          last_activity_at, entry_count, cost_micros, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, user_messages,
          assistant_messages, tool_calls, tool_results, total_messages, last_source
        ) VALUES (
          @session_id, @session_file, @parent_session_id, @parent_session_file, @cwd, @name, @started_at,
          @last_activity_at, @entry_count, @cost_micros, @input_tokens, @output_tokens,
          @cache_read_tokens, @cache_write_tokens, @total_tokens, @user_messages,
          @assistant_messages, @tool_calls, @tool_results, @total_messages, @source
        )
        ON CONFLICT (session_id) DO UPDATE SET
          session_file       = excluded.session_file,
          parent_session_id  = excluded.parent_session_id,
          parent_session_file = excluded.parent_session_file,
          cwd                = excluded.cwd,
          name               = excluded.name,
          started_at         = excluded.started_at,
          last_activity_at   = excluded.last_activity_at,
          entry_count        = excluded.entry_count,
          cost_micros       = excluded.cost_micros,
          input_tokens       = excluded.input_tokens,
          output_tokens      = excluded.output_tokens,
          cache_read_tokens  = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          total_tokens       = excluded.total_tokens,
          user_messages      = excluded.user_messages,
          assistant_messages = excluded.assistant_messages,
          tool_calls         = excluded.tool_calls,
          tool_results       = excluded.tool_results,
          total_messages     = excluded.total_messages,
          last_source        = excluded.last_source,
          updated_at         = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE @source = 'scan'
           OR excluded.entry_count >= sessions.entry_count
      `)
      .run({
        session_id: session.sessionId,
        session_file: session.sessionFile,
        parent_session_id: session.parentSessionId,
        parent_session_file: session.parentSessionFile ?? null,
        cwd: session.cwd ?? "",
        name: session.name,
        started_at: session.startedAt ?? session.lastActivityAt ?? "",
        last_activity_at: session.lastActivityAt ?? session.startedAt ?? "",
        entry_count: session.entryCount,
        cost_micros: session.costMicros,
        input_tokens: session.inputTokens,
        output_tokens: session.outputTokens,
        cache_read_tokens: session.cacheReadTokens,
        cache_write_tokens: session.cacheWriteTokens,
        total_tokens: session.totalTokens,
        user_messages: session.userMessages,
        assistant_messages: session.assistantMessages,
        tool_calls: session.toolCalls,
        tool_results: session.toolResults,
        total_messages: session.totalMessages,
        source,
      });

    if (result.changes === 0) return false;

    // The payload is the complete fact set, so replace it rather than merging.
    db.prepare("DELETE FROM usage_events WHERE session_id = ?").run(session.sessionId);

    const insertFact = db.prepare(`
      INSERT INTO usage_events (
        session_id, entry_id, kind, occurred_at, provider, model_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        total_tokens, cost_micros
      ) VALUES (
        @session_id, @entry_id, @kind, @occurred_at, @provider, @model_id,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @total_tokens, @cost_micros
      )
    `);
    for (const event of events) {
      insertFact.run({
        session_id: session.sessionId,
        entry_id: event.entryId,
        kind: event.kind,
        occurred_at: event.occurredAt,
        provider: event.provider,
        model_id: event.modelId,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        cache_read_tokens: event.cacheReadTokens,
        cache_write_tokens: event.cacheWriteTokens,
        total_tokens: event.totalTokens,
        cost_micros: event.costMicros,
      });
    }
    return true;
  });

  return write();
};
