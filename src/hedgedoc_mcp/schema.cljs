(ns hedgedoc-mcp.schema
  "Tool schemas, pure data. Shared by the single-note core and the multi-note
   supervisor so the two never drift.")

(def tool-defs
  [{:name "get-status"
    :description "Adapter state: rev, content hash, snapshot id, section list, remote-idle-ms, rev-velocity (revs/min, trailing 60s), connected flag. Read-only."
    :inputSchema {:type "object" :properties {} :additionalProperties false}}
   {:name "read-section"
    :description "Scoped read of one section by heading (case/space-insensitive anchor; :occurrence selects among duplicates). Returns rev, hash, content slice, UTF-16 offsets. Read-only."
    :inputSchema {:type "object"
                  :properties {:heading {:type "string"}
                               :occurrence {:type "integer" :minimum 0}}
                  :required ["heading"]
                  :additionalProperties false}}
   {:name "read-note"
    :description "Whole note (or page of lines, 1-based) with rev/hash, total-line count, truncated flag and the heading list with line numbers. This is the only tool that shows front matter and the doc title. Default up to 2000 lines."
    :inputSchema {:type "object"
                  :properties {:offset {:type "integer" :minimum 1}
                               :limit {:type "integer" :minimum 1 :maximum 2000}}
                  :additionalProperties false}}
   {:name "apply-ops"
    :description "CAS-gated write. Either caller :ops ([[tag value]] pairs, tag in retain/delete/insert, UTF-16 units, grapheme-safe, result under 100KB) or :new-section-text with :heading (replaces the section BODY only; the heading line is preserved, so do not include it in the text). Needs :base-rev + :base-hash from a fresh read; stale rejects with server rev/hash. :dry-run? returns a numbered preview window without emitting."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :ops {:type "array" :items {:type "array"} :minItems 1}
                               :new-section-text {:type "string"}
                               :heading {:type "string"}
                               :occurrence {:type "integer" :minimum 0}
                               :dry-run? {:type "boolean"}
                               :verify? {:type "boolean"}}
                  :required ["base-rev" "base-hash"]
                  :additionalProperties false}}
   {:name "append-to-section"
    :description "Pure insert of :text at the end of :heading's section (before the next heading). Same CAS/overlap/retry core as apply-ops; no separate path."
    :inputSchema {:type "object"
                  :properties {:heading {:type "string"}
                               :base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :text {:type "string"}
                               :occurrence {:type "integer" :minimum 0}
                               :dry-run? {:type "boolean"}
                               :verify? {:type "boolean"}}
                  :required ["heading" "base-rev" "base-hash" "text"]
                  :additionalProperties false}}
   {:name "replace-lines"
    :description "Line-oriented CAS write: edits [{:line (1-based) :old (exact current line) :new (single-line replacement)}], applied bottom-up. Rejects :line-mismatch / :line-out-of-range / :duplicate-line. Same CAS, overlap-abort and verification core as apply-ops; supports :dry-run? and :verify? false."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :edits {:type "array" :minItems 1
                                       :items {:type "object"
                                               :properties {:line {:type "integer" :minimum 1}
                                                            :old {:type "string"}
                                                            :new {:type "string"}}
                                               :required ["line" "old" "new"]}}
                               :dry-run? {:type "boolean"}
                               :verify? {:type "boolean"}}
                  :required ["base-rev" "base-hash" "edits"]
                  :additionalProperties false}}
   {:name "insert-lines"
    :description "Insert text (one or more lines) before 1-based :line; :line = total+1 appends. Same CAS/verify core as apply-ops; :dry-run? and :verify? supported."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :line {:type "integer" :minimum 1}
                               :text {:type "string"}
                               :dry-run? {:type "boolean"}
                               :verify? {:type "boolean"}}
                  :required ["base-rev" "base-hash" "line" "text"]
                  :additionalProperties false}}
   {:name "delete-lines"
    :description "Delete :count lines (default 1) starting at 1-based :line. Refuses to run past the end. Same CAS/verify core."
    :inputSchema {:type "object"
                  :properties {:base-rev {:type "integer"}
                               :base-hash {:type "string"}
                               :line {:type "integer" :minimum 1}
                               :count {:type "integer" :minimum 1}
                               :dry-run? {:type "boolean"}
                               :verify? {:type "boolean"}}
                  :required ["base-rev" "base-hash" "line"]
                  :additionalProperties false}}
   {:name "search"
    :description "Read-only line search: substring or regex, case-insensitive by default. Returns matching lines with 1-based line numbers, a truncated flag and the current rev/hash."
    :inputSchema {:type "object"
                  :properties {:query {:type "string"}
                               :regex? {:type "boolean"}
                               :case-sensitive? {:type "boolean"}
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

