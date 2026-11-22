(ns hedgedoc-mcp.schema
  "Tool schemas, pure data. Shared by the single-note core and the multi-note
   supervisor so the two never drift.")

(def tool-defs
  [{:name "get-status"
    :description "Server state: rev, content hash, snapshot id, section list, remote-idle-ms, rev-velocity (revs/min, trailing 60s), connected, writable, auth, plus worker (pid, version, noteId, startedAt, logGeneration) and socket (connected, lastDisconnectReason, lastConnectError, lastConnectAt, lastDisconnectAt, reconnectAttempts, nextAttemptAt, generation). waitMs waits up to that many ms for boot to land (and triggers a throttled reconnect while disconnected), then returns the status with waitedMs. forceReconnect disposes the socket and reconnects now; it refuses with force-reconnect-blocked while a write is in flight. Read-only."
    :inputSchema {:type "object"
                  :properties {:waitMs {:type "integer" :minimum 0 :maximum 15000
                                        :default 0}
                               :forceReconnect {:type "boolean" :default false}}
                  :additionalProperties false}}
   {:name "doctor"
    :description "Read-only health report, multi mode only (core refuses with doctor-requires-supervisor). Server /status and version, one entry per worker (socket state, rev, hash, writable, last error), the heartbeat registry rows with PIDs, duplicate note ids across live processes, and old-working-tree versus Nix version mismatches. Each worker query is capped at 5s; a wedged worker reports status \"timeout\" instead of hanging. Takes no arguments and no note-id. Never kills or reaps anything: act on the reported PIDs yourself."
    :inputSchema {:type "object" :properties {} :additionalProperties false}}
   {:name "read-section"
    :description "Scoped read of one section by heading (case/space-insensitive anchor; :occurrence selects among duplicates; :level 1..6 filters to that heading level with no fallback). includeSubsections reads from after the heading line to the next heading at or above that level and returns writeRoundTrip true plus the echoed fields (heading, level, occurrence, includeSubsections; no nested anchor object) so the slice can be written back: pass includeSubsections true to apply-ops with new-section-text, or to append-to-section. The heading line is always preserved. Returns rev, hash, content slice, UTF-16 offsets. Read-only."
    :inputSchema {:type "object"
                  :properties {:heading {:type "string"}
                               :occurrence {:type "integer" :minimum 0}
                               :level {:type "integer" :minimum 1 :maximum 6}
                               :includeSubsections {:type "boolean" :default false}}
                  :required ["heading"]
                  :additionalProperties false}}
   {:name "read-note"
    :description "Whole note (or page of lines, 1-based) with rev/hash, total-line count, truncated flag and the heading list with line numbers. sections: \"all\" (default) lists every heading; \"none\" returns [] to save tokens; \"window\" lists only headings inside the returned slice. Line numbers are always absolute document lines. Booleans are rejected: use \"none\". This is the only tool that shows front matter and the doc title. Default up to 2000 lines."
    :inputSchema {:type "object"
                  :properties {:offset {:type "integer" :minimum 1}
                               :limit {:type "integer" :minimum 1 :maximum 2000}
                               :sections {:enum ["all" "none" "window"]
                                          :default "all"}}
                  :additionalProperties false}}
   {:name "apply-ops"
    :description "CAS-gated write. Either caller :ops ([[tag value]] pairs, tag in retain/delete/insert, UTF-16 units, grapheme-safe, result under 100KB) or :new-section-text with :heading (replaces the section body only; the heading line is preserved, so do not include it in the text). Add includeSubsections true to replace the whole subtree instead (children included, heading line still preserved); :level 1..6 qualifies the heading when the same name exists at several levels. Include-flag rules: includeSubsections/:level are bad-args with raw :ops. Needs :base-rev + :base-hash from a fresh read; stale rejects with server rev/hash. :dryRun returns a numbered preview without emitting; :preview \"window\" (default, +-6 lines around the target), \"region\" (the whole affected range), or \"tail\" (the last 12 lines of it), capped at 200 lines / 4000 UTF-16 units."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :ops {:type "array" :items {:type "array"} :minItems 1}
                               :new-section-text {:type "string"}
                               :heading {:type "string"}
                               :occurrence {:type "integer" :minimum 0}
                               :level {:type "integer" :minimum 1 :maximum 6}
                               :includeSubsections {:type "boolean" :default false}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["base-rev" "base-hash"]
                  :additionalProperties false}}
   {:name "append-to-section"
    :description "Pure insert of :text at the end of :heading's section (before the next heading). includeSubsections true appends after the last child of that subtree, keeping the blank line before the next sibling; :level 1..6 qualifies the heading. Same CAS/overlap/retry core as apply-ops; no separate path. :dryRun returns a numbered preview of the insertion; :preview picks window (+-6 lines around the target), region (the inserted block), or tail (its last 12 lines)."
    :inputSchema {:type "object"
                  :properties {:heading {:type "string"}
                               :base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :text {:type "string"}
                               :occurrence {:type "integer" :minimum 0}
                               :level {:type "integer" :minimum 1 :maximum 6}
                               :includeSubsections {:type "boolean" :default false}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["heading" "base-rev" "base-hash" "text"]
                  :additionalProperties false}}
   {:name "replace-lines"
    :description "Line-oriented CAS write: edits [{:line (1-based) :old (exact current line) :new (single-line replacement)}], applied bottom-up. Rejects :line-mismatch / :line-out-of-range / :duplicate-line. Same CAS, overlap-abort and verification core as apply-ops; supports :dryRun, :preview (window/region/tail) and :verify false."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :edits {:type "array" :minItems 1
                                       :items {:type "object"
                                               :properties {:line {:type "integer" :minimum 1}
                                                            :old {:type "string"}
                                                            :new {:type "string"}}
                                               :required ["line" "old" "new"]}}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["base-rev" "base-hash" "edits"]
                  :additionalProperties false}}
   {:name "insert-lines"
    :description "Insert text (one or more lines) before 1-based :line; :line = total+1 appends. Same CAS/verify core as apply-ops; :dryRun, :preview (window/region/tail) and :verify supported."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :line {:type "integer" :minimum 1}
                               :text {:type "string"}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["base-rev" "base-hash" "line" "text"]
                  :additionalProperties false}}
   {:name "delete-lines"
    :description "Delete :count lines (default 1) starting at 1-based :line. Refuses to run past the end. Same CAS/verify core; :dryRun previews the removed lines with :preview window/region/tail."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :line {:type "integer" :minimum 1}
                               :count {:type "integer" :minimum 1}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["base-rev" "base-hash" "line"]
                  :additionalProperties false}}
   {:name "replace-range"
    :description "Replace an explicit line range (1-based, inclusive startLine..endLine) with newText, which may be multi-line. oldText must equal the current lines startLine..endLine joined by LF with no trailing newline: a mismatch is range-mismatch with expected/actual, a bad range is range-out-of-range, and a trailing newline in oldText is bad-args. The replacement consumes the newline after endLine, so line counts may change. Empty or whitespace-only newText deletes the range (deleting the whole document leaves a one-line blank document); identical old/new is a no-op. Same CAS/overlap/verify core as replace-lines; supports :dryRun, :preview (window/region/tail) and :verify false."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :startLine {:type "integer" :minimum 1}
                               :endLine {:type "integer" :minimum 1}
                               :oldText {:type "string"}
                               :newText {:type "string"}
                               :dryRun {:type "boolean"}
                               :preview {:enum ["window" "region" "tail"]
                                         :default "window"}
                               :verify {:type "boolean"}}
                  :required ["base-rev" "base-hash" "startLine" "endLine" "oldText" "newText"]
                  :additionalProperties false}}
   {:name "search"
    :description "Read-only line search: substring or regex, case-insensitive by default. Returns matching lines with 1-based line numbers, a truncated flag and the current rev/hash."
    :inputSchema {:type "object"
                  :properties {:query {:type "string"}
                               :regex {:type "boolean"}
                               :caseSensitive {:type "boolean"}
                               :limit {:type "integer" :minimum 1 :maximum 500}}
                  :required ["query"]
                  :additionalProperties false}}
   {:name "presence"
    :description "Advisory only: connected users, rev-velocity, remote-idle-ms, latest convertible cursor/selection snapshot. NEVER a gate; the gate is the pre-emit overlap check inside apply-ops."
    :inputSchema {:type "object" :properties {} :additionalProperties false}}
   {:name "set-note"
    :description "Whole-document replace, gated: requires :force true plus a non-blank :reason, :base-rev + :base-hash CAS, and :content. Same emit/verify core as apply-ops."
    :inputSchema {:type "object"
                  :properties {:force {:type "boolean"}
                               :reason {:type "string"}
                               :base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :content {:type "string"}}
                  :required ["force" "reason" "base-rev" "base-hash" "content"]
                  :additionalProperties false}}])

