(ns hedgedoc-mcp.errors
  "Pure error shaping: code/message extraction, the hint catalog, and the retry
   metadata table. No state and no effects, so the retry contract is testable
   without booting core.mjs (see test/error-shape.mjs)."
  (:require [clojure.string :as str]))

(defn err-message [e]
  (let [m (when (some? e) (.-message e))]
    (if (and (some? m) (not (= m ""))) m (str e))))

(defn err-code [e]
  (let [c (:code (ex-data e))]
    (cond (string? c) (str/replace (str c) ":" "")
          :else "internal")))

(def hint-catalog
  "One actionable sentence per code. The error data may add its own :hint;
   that one always wins."
  {"stale-revision"
   "Re-read (get-status / read-section) and retry with the new base-rev and base-hash; never reuse the old base."

   "target-moved"
   "The target changed while the write was in flight. Re-read the section and recompute the edit."

   "overlap-abort"
   "A remote selection overlaps the target range. Wait for the remote edit to land, or pick a range outside it."

   "missing-heading"
   "Heading not found. get-status lists every heading; see data.did-you-mean for near matches."

   "duplicate-heading"
   "Heading appears more than once. Pass :occurrence (0-based) to choose one; see data.candidates."

   "fence-split"
   "The edit boundary or replacement text would break a fenced code block. Move the boundary or fix the fence."

   "applied-but-unconfirmed"
   "The ack positioned the op but persistence is unconfirmed. Check get-status; do NOT re-emit."

   "info-abort"
   "The server refused the operation (see data.info-code). Do not retry unchanged."

   "retry-exhausted"
   "Bounded retries are exhausted. Re-read the document and start a fresh edit."

   "not-connected"
   "The socket is down. Check get-status.connected and retry after reconnect."

   "not-booted"
   "Boot has not landed yet. Retry in a few seconds."

   "write-needs-user"
   "This is a guest session. Provide a registered HEDGEDOC_COOKIE, or set HEDGEDOC_ALLOW_GUEST_WRITES=true on a guest-open instance."

   "unauthorized"
   "The session is not allowed to read or edit this note. Check the cookie and the note permission."

   "download-failed"
   "GET /download failed. Check HEDGEDOC_URL, the note id, the cookie, and network reachability."

   "bad-args"
   "An argument is wrong. data.field / data.fields name it."

   "incompatible-client"
   "Server and client majors disagree. Set HEDGEDOC_CLIENT_MAJOR to 4 for HedgeDoc 1.11/1.12."

   "refused"
   "The operation is refused by policy; see data.reason."

   "rev-unknown"
   "The revision is unknown after a reconnect. Wait for the doc frame (get-status) and retry."

   "no-op"
   "The edit changes nothing. Skip it or change the replacement text."

   "oversize"
   "The result would exceed the 100KB note cap. Split the edit."

   "occurrence-out-of-range"
   "There are fewer duplicate headings than :occurrence claims. Re-read and retry."

   "emit-in-flight"
   "Another write is still in flight. Wait for it to finish, then retry."

   "unknown-tool"
   "No such tool; call tools/list."

   "line-mismatch"
   "A :old line does not match the document. Re-read (read-note/read-section) and fix the edit."

   "line-out-of-range"
   "A :line is outside 1..total-lines. Re-read and retry."

   "duplicate-line"
   "The same :line appears twice in one batch. Merge the edits."

   "range-mismatch"
   "oldText does not equal the current lines. Re-read (read-note/read-section) and rebuild oldText from the live lines, joined by LF with no trailing newline."

   "range-out-of-range"
   "startLine/endLine must be integers with 1 <= startLine <= endLine <= total lines. Re-read the note for current line numbers."})

(defn hint-for [code]
  (get hint-catalog (str code)))

(def retry-table
  "Top-level retry advice per code. A code absent from this table gets no
   :retryable / :retryAfterMs at all -- :download-failed is deliberately
   absent because the write poll swallows it and a retry hint would be a lie."
  {"not-connected" {:retryable true :retryAfterMs 1000}
   "rev-unknown" {:retryable false}
   "stale-revision" {:retryable false}
   "emit-in-flight" {:retryable false}
   "write-needs-user" {:retryable false}})

(defn retry-for [code]
  (get retry-table (str code)))

(defn shape-error
  "The MCP error payload {:code :message :data}, plus top-level :retryable and
   :retryAfterMs when the code has advice. data.hint wins over the catalog."
  [code message data]
  (let [data (dissoc (or data {}) :code)
        hint (hint-for code)]
    (merge {:code code
            :message message
            :data (if (or (some? (:hint data)) (nil? hint))
                    data
                    (assoc data :hint hint))}
           (retry-for code))))

(defn err-map [e]
  (shape-error (err-code e) (err-message e) (ex-data e)))
