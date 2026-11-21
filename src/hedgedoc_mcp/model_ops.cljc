(ns hedgedoc-mcp.model-ops
  "T3 pure pt2: sections, offsets, prefix/suffix ops, apply.
   Reuses hedgedoc-mcp.model for normalize/hash/UTF-16/trailing-newline.
   Pure: no sockets, no clock, no globals. Failures are ex-info."
  (:require [clojure.string :as str]
            [hedgedoc-mcp.model :as base]))

(def max-content-units 102400)
;; 100KB cap in UTF-16 units. Over -> :oversize reject; caller splits by section.

;; ---------- heading anchors ----------

(defn normalize-heading
  "Case/space-insensitive anchor key: trim, collapse runs, lowercase."
  [h]
  (-> (or h "") str/trim (str/replace #"\s+" " ") str/lower-case))

;; A closing # sequence only counts when whitespace precedes it: "C#" is a
;; heading titled C#, not C.
(def ^:private atx-re #"^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
(def ^:private fence-re #"^ {0,3}```")

(defn parse-sections
  "Normalized content -> [{:level :heading :normalized :start :end
                            :occurrence :count}].
   :start = heading-line start (incl. heading), :end = next heading start
   or doc end (exclusive). Offsets are UTF-16 units. Fence-aware: headings
   inside ``` blocks are ignored. No headings -> [].
   Indexed iteration only: squint's `rest` is an unmemoized generator and made
   this superlinear (841 lines took 7.3 s), which stalled the event loop past
   socket.io's heartbeat and caused disconnects."
  [normalized]
  (assert (base/trailing-nl-valid? normalized) "parse-sections needs normalized content")
  (let [total (base/utf16-length normalized)
        all-lines (vec (str/split normalized #"\n" -1))
        n (max 0 (dec (count all-lines)))
        body (subvec all-lines 0 n)
        starts (loop [i 0 off 0 acc []]
                 (if (>= i n)
                   acc
                   (let [line (nth body i)]
                     (recur (inc i)
                            (+ off (base/utf16-length line) 1)
                            (conj acc off)))))
         ;; Leading YAML front matter is not markdown: a "# comment" inside it
         ;; is not a heading. Skip the fenced block when the doc opens with ---.
         fm-end (if (and (pos? n) (= (nth body 0) "---"))
                  (loop [i 1]
                    (cond
                      (>= i n) n
                      (= (nth body i) "---") (inc i)
                      :else (recur (inc i))))
                  0)
        heads (loop [i 0 in-fence? false acc []]
                 (if (>= i n)
                   acc
                   (let [line (nth body i)
                         off (nth starts i)
                         fenced? (boolean (re-find fence-re line))]
                     (cond
                       (< i fm-end) (recur (inc i) in-fence? acc)
                       fenced? (recur (inc i) (not in-fence?) acc)
                       (and (not in-fence?) (re-matches atx-re line))
                       (let [[_ hashes text] (re-matches atx-re line)]
                         (recur (inc i) in-fence?
                                (conj acc {:level (count hashes)
                                           :heading text
                                           :normalized (normalize-heading text)
                                           :start off})))
                       :else (recur (inc i) in-fence? acc)))))
        counts (frequencies (mapv #(:normalized %) heads))
        hn (count heads)]
    (loop [j 0 seen {} out []]
      (if (>= j hn)
        out
        (let [h (nth heads j)
              k (:normalized h)
              occ (get seen k 0)
              end (if (< (inc j) hn) (:start (nth heads (inc j))) total)]
          (recur (inc j)
                 (assoc seen k (inc occ))
                 (conj out (assoc h :occurrence occ
                                    :count (get counts k)
                                    :end end))))))))

(defn- content-start-of
  "Offset of first char after the heading line starting at `off`."
  [normalized off]
  (let [nl (str/index-of normalized "\n" off)]
    (if (nil? nl) (base/utf16-length normalized) (inc nl))))

(defn section->offsets
  "Anchor lookup -> {:start :end} *content* range (after heading line -> section end).
   Case/space-insensitive; see anchor semantics above for missing/dup behavior."
  [sections normalized-content heading {:keys [occurrence]}]
  (let [k    (normalize-heading heading)
        hits (filterv #(= (:normalized %) k) sections)]
    (cond
      (empty? hits)
      (let [avail (mapv #(:normalized %) sections)
           dym   (filterv #(or (str/starts-with? % k) (str/starts-with? k %)) avail)]
        (throw (ex-info (str "missing heading: " heading)
                        {:code :missing-heading :heading heading :normalized k
                         :available avail :did-you-mean (vec (take 3 dym))})))
      (and (> (count hits) 1) (nil? occurrence))
      (throw (ex-info (str "duplicate heading: " heading)
                      {:code :duplicate-heading :heading heading :normalized k
                       :candidates (mapv #(select-keys % [:occurrence :start :end :heading]) hits)}))
      :else
      (let [h (if (some? occurrence) (get hits occurrence) (first hits))]
        (when (nil? h)
          (throw (ex-info (str "occurrence out of range: " heading " #" occurrence)
                          {:code :occurrence-out-of-range :heading heading
                           :normalized k :occurrence occurrence :count (count hits)})))
        {:start (content-start-of normalized-content (:start h)) :end (:end h)}))))

(defn read-section
  "Convenience: offsets + text slice. Thin wrapper over section->offsets."
  [sections normalized-content heading {:keys [occurrence]}]
  (let [{:keys [start end]} (section->offsets sections normalized-content heading {:occurrence occurrence})]
    {:start start :end end :content (subs normalized-content start end)}))

;; ---------- grapheme-safe cuts (UTF-16) ----------

(defn- cu [s i]
  #?(:clj  (int (.charAt ^String s ^long i))
     :cljs (.charCodeAt s i)))

(defn- high-surrogate? [u] (and (>= u 0xD800) (<= u 0xDBFF)))
(defn- low-surrogate? [u] (and (>= u 0xDC00) (<= u 0xDFFF)))
(defn- extend-unit? [u]
  (or (= u 0x200D) ; ZWJ
      (and (>= u 0x0300) (<= u 0x036F))   ; combining diacriticals
      (and (>= u 0x1AB0) (<= u 0x1AFF))
      (and (>= u 0x1DC0) (<= u 0x1DFF))
      (and (>= u 0x20D0) (<= u 0x20FF))
      (and (>= u 0xFE00) (<= u 0xFE0F))   ; variation selectors
      (and (>= u 0xFE20) (<= u 0xFE2F))))

(defn cut-safe?
  "True if cutting s between units i-1 and i splits no surrogate pair,
   ZWJ join, or combining/VS sequence. 0 and len are always safe."
  [s i]
  (let [n (base/utf16-length s)]
    (cond (or (<= i 0) (>= i n)) true
          (high-surrogate? (cu s (dec i))) false
          (low-surrogate? (cu s i)) false
          (= (cu s (dec i)) 0x200D) false
          (= (cu s i) 0x200D) false
          (extend-unit? (cu s i)) false
          :else true)))

(defn snap-back [s i]
  "Move cut backward to nearest safe point (0 if none)."
  (loop [j (min i (base/utf16-length s))]
    (if (or (<= j 0) (cut-safe? s j)) j (recur (dec j)))))

(defn snap-fwd [s i]
  "Move cut forward to nearest safe point (len if none)."
  (let [n (base/utf16-length s)]
    (loop [j (max 0 i)]
      (if (or (>= j n) (cut-safe? s j)) j (recur (inc j))))))

;; ---------- prefix/suffix diff -> ops ----------

(defn- common-prefix-len [a b]
  (let [na (base/utf16-length a) nb (base/utf16-length b)]
    (loop [i 0]
      (if (or (>= i na) (>= i nb) (not= (cu a i) (cu b i))) i (recur (inc i))))))

(defn- common-suffix-len [a b max-k]
  (let [na (base/utf16-length a) nb (base/utf16-length b)]
    (loop [k 0]
      (if (or (>= k max-k) (not= (cu a (- na 1 k)) (cu b (- nb 1 k)))) k (recur (inc k))))))

(defn content->ops
  "Prefix/suffix diff old -> new (both normalized).
   Returns op vector of [:retain n] / [:delete n] / [:insert s] (elided when empty).
   Cuts snap to grapheme-safe points; snaps that invert the span abort
   :unsplittable-boundary. New content over max-content-units aborts :oversize."
  [old new]
  (assert (base/trailing-nl-valid? old) "content->ops needs normalized old")
  (assert (base/trailing-nl-valid? new) "content->ops needs normalized new")
  (when (> (base/utf16-length new) max-content-units)
    (throw (ex-info "new content over 100KB cap; caller splits by section"
                    {:code :oversize :units (base/utf16-length new) :cap max-content-units})))
  (let [no  (base/utf16-length old)
        nn  (base/utf16-length new)
        pre (snap-back old (common-prefix-len old new))
        suf (common-suffix-len old new (min (- no pre) (- nn pre)))
        s0  (snap-fwd old (- no suf)) ; old-side suffix boundary, snapped
        t0  (snap-fwd new (- nn suf))] ; new-side suffix boundary, snapped
    (when (or (> pre s0) (> pre t0))
      (throw (ex-info "diff boundary unsplittable without breaking a grapheme"
                      {:code :unsplittable-boundary :prefix pre :old-suffix-at s0 :new-suffix-at t0})))
    (cond-> []
      (pos? pre)       (conj [:retain pre])
      (pos? (- s0 pre)) (conj [:delete (- s0 pre)])
      (pos? (- t0 pre)) (conj [:insert (subs new pre t0)])
      (pos? (- no s0))  (conj [:retain (- no s0)]))))

;; ---------- fences ----------

(defn- fence-toggle-lines [s]
  (filterv #(boolean (re-find fence-re %)) (str/split-lines s)))

(defn fence-odd? [s]
  "True if s contains an odd number of ``` openers (unbalanced span)."
  (odd? (count (fence-toggle-lines s))))

(defn in-fence?
  "True if `offset` lies strictly inside a fenced block of normalized content."
  [normalized offset]
  (let [head (subs normalized 0 (max 0 (min offset (base/utf16-length normalized))))]
    (odd? (count (fence-toggle-lines head)))))

;; ---------- section-level op builders ----------

(defn section-replace-ops
  "Ops replacing the content range of `heading` with `new-text`.
   Aborts :fence-split if a range boundary lies inside a fence, the old span
   has odd fence parity (would orphan the other half), or new-text is unbalanced."
  [old-content sections heading new-text {:keys [occurrence]}]
  (assert (base/trailing-nl-valid? old-content) "section-replace-ops needs normalized old")
  (let [{:keys [start end]} (section->offsets sections old-content heading {:occurrence occurrence})
        span (subs old-content start end)
        repl0 (base/normalize new-text)
        ;; keep a blank line before the next heading, exactly like append
        repl (if (< end (base/utf16-length old-content)) (str repl0 "\n") repl0)]
    (cond
      (or (in-fence? old-content start) (in-fence? old-content end))
      (throw (ex-info "replace boundary lies inside a fenced block"
                      {:code :fence-split :reason :boundary-in-fence :start start :end end}))
      (fence-odd? span)
      (throw (ex-info "old span has unbalanced fence; replace would orphan the other half"
                      {:code :fence-split :reason :orphaned-fence :start start :end end}))
      (fence-odd? repl)
      (throw (ex-info "replacement text has unbalanced fence"
                      {:code :fence-split :reason :unbalanced-replacement})))
    (content->ops old-content
                  (base/ensure-one-trailing-nl
                   (str (subs old-content 0 start) repl (subs old-content end))))))

(defn append-to-section-ops
  "Pure insert of `text` (normalized to exactly-one-\\n block) at section end
   (before next heading). Aborts :fence-split if the insert point is in-fence."
  [old-content sections heading text {:keys [occurrence]}]
  (assert (base/trailing-nl-valid? old-content) "append-to-section-ops needs normalized old")
  (when (str/blank? text)
    (throw (ex-info "append text is blank"
                    {:code :no-op :reason :blank-append-text})))
  (let [{:keys [end]} (section->offsets sections old-content heading {:occurrence occurrence})
        ;; appending at a section boundary puts us directly before the next
        ;; heading; keep a blank line so the heading stays a heading.
        block (let [b (base/normalize text)]
                (if (< end (base/utf16-length old-content)) (str b "\n") b))]
    (when (in-fence? old-content end)
      (throw (ex-info "append point lies inside a fenced block"
                      {:code :fence-split :reason :append-in-fence :end end})))
    (when (> (+ (base/utf16-length old-content) (base/utf16-length block)) max-content-units)
      (throw (ex-info "append would exceed 100KB cap"
                      {:code :oversize :cap max-content-units})))
    (when-not (cut-safe? old-content end)
      (throw (ex-info "append point splits a grapheme (defensive; section ends are line starts)"
                      {:code :split-boundary :offset end})))
    (cond-> []
      (pos? end) (conj [:retain end])
      :always (conj [:insert block])
      (pos? (- (base/utf16-length old-content) end)) (conj [:retain (- (base/utf16-length old-content) end)]))))

;; ---------- apply ----------

(defn- apply-ops*
  "Shared fold. normalize?/cap? are false for remote wire ops: the server's
   base includes the trailing-newline tail we keep outside normalized content,
   and a large read-only note must still fold remote edits."
  [content ops normalize? cap?]
  (when normalize?
    (assert (base/trailing-nl-valid? content) "apply-ops needs normalized content"))
  (let [n  (base/utf16-length content)
        sb #?(:clj (StringBuilder.) :cljs #js [])]
    (loop [pos 0 rs ops]
      (if (empty? rs)
        (let [tail (subs content pos n)
              out  #?(:clj (str (.toString sb) tail) :cljs (str (.join sb "") tail))]
          (when (and cap? (> (base/utf16-length out) max-content-units))
            (throw (ex-info "apply result over 100KB cap" {:code :oversize :cap max-content-units})))
          (if normalize? (base/ensure-one-trailing-nl out) out))
        (let [[op a] (first rs)]
          (case op
            :retain
            (do (when (or (not (integer? a)) (neg? a) (> (+ pos a) n))
                  (throw (ex-info "retain out of bounds" {:code :bad-op :op [:retain a] :pos pos :len n})))
                (when-not (and (cut-safe? content pos) (cut-safe? content (+ pos a)))
                  (throw (ex-info "retain splits a grapheme" {:code :split-boundary :pos pos :n a})))
                #?(:clj (.append sb (subs content pos (+ pos a)))
                   :cljs (.push sb (subs content pos (+ pos a))))
                (recur (+ pos a) (rest rs)))
            :delete
            (do (when (or (not (integer? a)) (neg? a) (> (+ pos a) n))
                  (throw (ex-info "delete out of bounds" {:code :bad-op :op [:delete a] :pos pos :len n})))
                (when-not (and (cut-safe? content pos) (cut-safe? content (+ pos a)))
                  (throw (ex-info "delete splits a grapheme" {:code :split-boundary :pos pos :n a})))
                (recur (+ pos a) (rest rs)))
            :insert
            (do (when (not (string? a))
                  (throw (ex-info "insert needs a string" {:code :bad-op :op [:insert a]})))
                #?(:clj (.append sb ^String a) :cljs (.push sb a))
                (recur pos (rest rs)))
            (throw (ex-info "unknown op" {:code :bad-op :op (first rs)}))))))))

(defn apply-ops
  "Fold ops over normalized content. Validates: known op, non-negative n,
   bounds, grapheme-safe retain/delete cuts (abort :split-boundary), oversize
   result. Trailing retain explicit (base_length == doc length). Re-asserts
   exactly-one trailing \\n on the result. Pure."
  [content ops]
  (apply-ops* content ops true true))

(defn apply-ops-raw
  "Fold a remote wire op over the server's raw content (normalized content plus
   its trailing-newline tail). No cap: reads of large notes must not throw.
   Returns raw text; the caller normalizes and recomputes the tail. Pure."
  [content ops]
  (apply-ops* content ops false false))

;; ---------- moved predicates (from tools/core) ----------

(defn cas-check
  "Pure CAS gate. Throws ex-info :stale-revision on rev/hash mismatch."
  [snap base-rev base-hash]
  (when (or (not= (:rev snap) base-rev)
            (not= (:hash snap) base-hash))
    (throw (ex-info "stale revision"
                    {:code :stale-revision
                     :base-rev base-rev :base-hash base-hash
                     :server-rev (:rev snap) :server-hash (:hash snap)}))))

(defn target-range-of-ops
  "Conservative affected range of caller ops: [first-non-retain-pos, len)."
  [content op-list]
  (loop [pos 0 rs op-list]
    (if (empty? rs)
      [pos pos]
      (let [[op a] (first rs)]
        (if (= op :retain)
          (recur (+ pos a) (rest rs))
          [pos (base/utf16-length content)])))))

(defn overlap-check
  "Inside apply-ops pre-emit (NOT advisory). Any remote selection touching
   [start,end) at the snapshot rev, or any rev move since snapshot, aborts."
  [presence-snap target-start target-end snap-rev]
  (doseq [{:keys [rev start end]} (:selections presence-snap)]
    (when (and (= rev snap-rev)
               (< (max (or start 0) target-start)
                  (min (or end 0) target-end)))
      (throw (ex-info "remote selection overlaps edit target"
                      {:code :overlap-abort
                       :reason :remote-selection-overlap
                       :target [target-start target-end]
                       :remote {:rev rev :start start :end end}})))))

(defn- line-spans
  "Vector of {:start :end} (UTF-16, end excludes the newline) per logical line.
   Content is normalized (exactly one trailing newline), so two lines plus a
   trailing newline yield two spans."
  [content]
  (let [n (base/utf16-length content)]
    (loop [pos 0 acc []]
      (if (>= pos n)
        acc
        (let [nl (str/index-of content "\n" pos)]
          (if (nil? nl)
            (conj acc {:start pos :end n})
            (recur (inc nl) (conj acc {:start pos :end nl}))))))))

(defn replace-lines->ops
  "1-based line edits [{:line :old :new}] -> {:ops :target-start :target-end}.
   :old must equal the current line exactly (content CAS), :new is one line.
   Edits apply bottom-up so earlier line numbers stay valid. Target range is
   the exact edited span, so overlap-abort stays proportionate."
  [normalized edits]
  (when (not (sequential? edits))
    (throw (ex-info "edits must be an array"
                    {:code :bad-args :field :edits})))
  (when (empty? edits)
    (throw (ex-info "edits must be non-empty"
                    {:code :bad-args :field :edits})))
  (let [spans (line-spans normalized)
        lines (mapv (fn [sp] (subs normalized (:start sp) (:end sp))) spans)
        n (count lines)]
    (doseq [e edits]
      (let [l (:line e)
            old (:old e)
            new (:new e)]
        (when (or (not (.isInteger js/Number l)) (< l 1) (> l n))
          (throw (ex-info (str "line out of range: " l)
                          {:code :line-out-of-range :line l :line-count n})))
        (when (not (string? old))
          (throw (ex-info "edit needs a string :old"
                          {:code :bad-args :field :old :line l})))
        (when (not (string? new))
          (throw (ex-info "edit needs a string :new"
                          {:code :bad-args :field :new :line l})))
        (when (or (str/includes? new "\n") (str/includes? new "\r"))
          (throw (ex-info "replacement must be a single line"
                          {:code :bad-args :field :new :line l})))
        (let [actual (nth lines (dec l))]
          (when (not= old actual)
            (throw (ex-info (str "line " l " does not match")
                            {:code :line-mismatch :line l
                             :expected old :actual actual}))))))
    (let [nums (mapv (fn [e] (:line e)) edits)]
      (when (not= (count nums) (count (distinct nums)))
        (throw (ex-info "duplicate line edits"
                        {:code :duplicate-line :lines nums}))))
    (let [out (reduce (fn [ls e] (assoc ls (dec (:line e)) (:new e)))
                      lines
                      (reverse (sort-by (fn [e] (:line e)) edits)))
          new-content (base/ensure-one-trailing-nl (str/join "\n" out))
          _ (when (= new-content normalized)
              (throw (ex-info "edits are a no-op"
                              {:code :no-op :reason :lines-unchanged})))
          ops (content->ops normalized new-content)
          starts (mapv (fn [e] (:start (nth spans (dec (:line e))))) edits)
          ends (mapv (fn [e] (:end (nth spans (dec (:line e))))) edits)]
      (when (empty? ops)
        (throw (ex-info "edits are a no-op"
                        {:code :no-op :reason :lines-unchanged})))
      {:ops ops
       :target-start (apply min starts)
       :target-end (apply max ends)})))

(defn insert-lines->ops
  "Insert normalized `text` before 1-based `line` (line = n+1 appends).
   Returns {:ops :target-start :target-end}; target is a point."
  [normalized line text]
  (when-not (string? text)
    (throw (ex-info "insert needs string :text" {:code :bad-args :field :text})))
  (let [spans (line-spans normalized)
        n (count spans)
        _ (when (or (not (.isInteger js/Number line)) (< line 1) (> line (inc n)))
            (throw (ex-info (str "line out of range: " line)
                            {:code :line-out-of-range :line line :line-count n})))
        offset (if (> line n)
                 (base/utf16-length normalized)
                 (:start (nth spans (dec line))))
        block (base/normalize text)]
    (when (str/blank? block)
      (throw (ex-info "insert text is empty" {:code :no-op :reason :empty-insert})))
    (when (> (+ (base/utf16-length normalized) (base/utf16-length block)) max-content-units)
      (throw (ex-info "insert would exceed 100KB cap" {:code :oversize :cap max-content-units})))
    (when-not (cut-safe? normalized offset)
      (throw (ex-info "insert point splits a grapheme (defensive; line starts are safe)"
                      {:code :split-boundary :offset offset})))
    {:ops (cond-> []
            (pos? offset) (conj [:retain offset])
            :always (conj [:insert block])
            (pos? (- (base/utf16-length normalized) offset))
            (conj [:retain (- (base/utf16-length normalized) offset)]))
     :target-start offset
     :target-end offset}))

(defn delete-lines->ops
  "Delete `count` lines starting at 1-based `line`. Refuses to delete past
   the end. Returns {:ops :target-start :target-end}."
  [normalized line n-lines]
  (let [spans (line-spans normalized)
        n (count spans)
        cnt (or n-lines 1)]
    (when (or (not (.isInteger js/Number line)) (< line 1) (> line n))
      (throw (ex-info (str "line out of range: " line)
                      {:code :line-out-of-range :line line :line-count n})))
    (when (or (not (.isInteger js/Number cnt)) (< cnt 1))
      (throw (ex-info "count must be a positive integer"
                      {:code :bad-args :field :count :got cnt})))
    (when (> (+ line cnt -1) n)
      (throw (ex-info (str "delete range past end: " line "+" cnt)
                      {:code :line-out-of-range :line line :count cnt :line-count n})))
    (let [start (:start (nth spans (dec line)))
          last-end (:end (nth spans (+ line cnt -2)))
          end (if (< last-end (base/utf16-length normalized)) (inc last-end) last-end)
          raw (str (subs normalized 0 start) (subs normalized end))
          new-content (if (str/blank? raw) "\n" raw)
          ops (content->ops normalized new-content)]
      (when (empty? ops)
        (throw (ex-info "delete is a no-op" {:code :no-op :reason :nothing-removed})))
      {:ops ops :target-start start :target-end end})))

(defn resolve-ops
  "Build-or-validate op vector. Returns {:ops :target-start :target-end
   :heading-or-nil :occurrence}. Throws ex-info with :code on failure."
  [snap-content {:keys [ops new-section-text heading occurrence target-range]}]
  (cond
    (and ops new-section-text)
    (throw (ex-info ":ops and :new-section-text are exclusive"
                    {:code :bad-args :reason ":ops and :new-section-text are exclusive"}))

    ops
    (do (apply-ops snap-content ops)
        (when (empty? ops)
          (throw (ex-info "empty op list is a no-op"
                          {:code :no-op :reason :empty-op-list-no-state-change})))
        (let [[s e] (or target-range (target-range-of-ops snap-content ops))]
          {:ops ops :target-start s :target-end e :heading-or-nil nil :occurrence nil}))

    new-section-text
    (do (when (or (not (string? heading)) (str/blank? heading))
          (throw (ex-info "new-section-text needs :heading" {:code :bad-args :field :heading})))
        (let [sections (parse-sections snap-content)
              computed (section-replace-ops snap-content sections heading new-section-text
                                           {:occurrence occurrence})
              {:keys [start end]} (section->offsets sections snap-content heading
                                                   {:occurrence occurrence})]
          (when (empty? computed)
            (throw (ex-info "empty op list is a no-op"
                            {:code :no-op :reason :empty-op-list-no-state-change
                             :heading heading :occurrence occurrence})))
          {:ops computed :target-start start :target-end end
           :heading-or-nil heading :occurrence occurrence}))

    :else
    (throw (ex-info "need :ops or :new-section-text"
                    {:code :bad-args :reason "need :ops or :new-section-text"}))))
