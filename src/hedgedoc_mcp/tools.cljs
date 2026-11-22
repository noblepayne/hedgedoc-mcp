(ns hedgedoc-mcp.tools
  "Thin dispatch + CAS + overlap-abort + bounded retry. No sockets directly;
   all effects via env. Single async implementation (v0.2)."
  (:require [clojure.string :as str]
            [hedgedoc-mcp.model :as m]
            [hedgedoc-mcp.model-ops :as ops]
            [hedgedoc-mcp.state :as st]))

;; ---------- errors ----------

(defn- err [code data]
  (ex-info (str "hedgedoc-mcp: " code) (assoc data :code code)))

(defn- write-auth-check!
  "A guest session cannot join the OT room on 1.11/1.12, so a write would
   fail at join time with no useful message. Fail here instead. :unknown
   (the /me probe itself failed) is allowed: the server stays the authority
   and CAS still protects content."
  [{:keys [auth allow-guest-writes?]}]
  (when (and (some? auth) (not allow-guest-writes?))
    (let [a (auth)]
      (when (= :guest (:kind a))
        (throw (err :write-needs-user
                    {:auth (select-keys a [:kind :status :name])
                     :why "guest session; writes need a registered session"}))))))

;; ---------- small helpers ----------

(defn- lines-of [s] (str/split-lines s))

(defn- region-lines
  "Target line-region of a section heading in content, for intent checks.
   Occurrence is threaded (single implementation)."
  [content heading occurrence]
  (let [sections (ops/parse-sections content)
        {:keys [start end]} (ops/section->offsets sections content heading
                                                  {:occurrence occurrence})
        body (subs content start end)]
    {:start start :end end :lines (lines-of body)}))

(defn- outside-equal?
  "True when everything outside [start,end) is byte-identical pre/post."
  [before after start end]
  (and (= (subs before 0 start) (subs after 0 start))
       (= (subs before end) (subs after end))))

(defn- safe-subs [s start end]
  (try
    (subs s start (min end (m/utf16-length s)))
    (catch :default _e nil)))

(defn- region-intent?
  "Spec §4/§5 region-intent check: target lines/span as expected AND
   everything outside the target unchanged.  Region-scoped equality, never a
   whole-doc hash under concurrency."
  [pre actual]
  (try
    (let [{:keys [target-start target-end heading-or-nil occurrence
                  new-target-start new-target-end]} pre
          expected (:new-content pre)]
      (if heading-or-nil
        (let [want (:lines (region-lines expected heading-or-nil occurrence))
              have (:lines (region-lines actual heading-or-nil occurrence))]
          (and (= want have)
               (outside-equal? expected actual target-start target-end)))
        (let [ns (or new-target-start target-start)
              ne (or new-target-end target-end)]
          (and (= (safe-subs expected ns ne) (safe-subs actual ns ne))
               (outside-equal? expected actual ns ne)))))
    (catch :default _ false)))

(defn- download-content
  "One read-only /download.  Accepts either the env map {:content s} or a
   raw string from a fake/test env."
  [fetch-download]
  (-> (fetch-download)
      (.then (fn [got]
               (m/normalize (if (string? got) got (:content got)))))))

(defn- phase-b-poll!
  "Phase B (SPEC §5): read-only /download poll every poll-ms up to
   poll-timeout-ms.  Returns {:ok bool :content normalized-or-nil}.  Never
   emits or mutates state."
  [env pre]
  (let [{:keys [fetch-download sleep-ms poll-ms poll-timeout-ms]} env
        poll-ms (or poll-ms 500)
        timeout-ms (or poll-timeout-ms 10000)
        max-polls (max 1 (js/Math.ceil (/ timeout-ms poll-ms)))]
    (if (nil? fetch-download)
      (js/Promise.resolve {:ok true :skipped true :content nil})
      (letfn [(step [attempt]
                (-> (download-content fetch-download)
                    (.then (fn [actual]
                             (cond
                               (region-intent? pre actual)
                               {:ok true :content actual :attempts (inc attempt)}

                               (>= attempt (dec max-polls))
                               {:ok false :content actual :attempts (inc attempt)}

                               :else
                               (-> (sleep-ms poll-ms)
                                   (.then (fn [_] (step (inc attempt))))))))
                    (.catch (fn [_e]
                              (if (>= attempt (dec max-polls))
                                {:ok false :content nil :attempts (inc attempt)}
                                (-> (sleep-ms poll-ms)
                                    (.then (fn [_] (step (inc attempt))))))))))]
        (step 0)))))

(defn- phase-b-result
  "Shape the Phase-B outcome.  Timeout is applied-but-unconfirmed: read-only,
   no re-emit, never a success."
  [state pre poll op-id]
  (let [new-rev (:rev @state)
        new-hash (st/content-hash @state)
        preview (subs (:new-content pre) 0
                      (min 2000 (m/utf16-length (:new-content pre))))]
    (if (:ok poll)
      {:new-rev new-rev
       :new-hash new-hash
       :preview preview
       :verified :download-poll
       :via :download-poll
       :status :confirmed
       :op-id op-id}
      {:new-rev new-rev
       :new-hash new-hash
       :preview preview
       :verified false
       :via :none
       :status :applied-but-unconfirmed
       :retryable false
       :expected-hash (m/content-hash (:new-content pre))
       :server-hash (when (:content poll) (m/content-hash (:content poll)))
       :hint "write may be applied; do NOT re-emit without verifying rev-did-not-advance"
       :op-id op-id})))

(defn- idle-advisory! [env state-value]
  (let [idle (st/remote-idle-ms state-value (:now-ms env))
        threshold (:idle-ms env)]
    (when (and (some? threshold) (< idle threshold))
      (.write (.-stderr js/process)
              (str "write: remote active (idle " idle "ms < threshold "
                   threshold "ms); proceeding, overlap-abort is the gate
")))))

;; ---------- 1. get-status ----------

(defn writable?
  "Write readiness: a revision learned on this socket generation, a live
   connection, and a session allowed to join the OT room. A missing (nil) or
   :unknown auth probe counts as allowed; the server stays the authority and
   CAS still protects content, matching write-auth-check!."
  [{:keys [state connected? auth allow-guest-writes?]}]
  (let [v @state
        a (when (some? auth) (auth))]
    (and (some? v)
         (>= (:rev v) 0)
         (boolean (connected?))
         (or (true? allow-guest-writes?)
             (not= :guest (:kind a))))))

(defn get-status
  "=> {:rev :hash :snapshot-id :sections :remote-idle-ms :rev-velocity
       :rev-known :connected :auth :writable :hint}
   Nil-tolerant: before boot lands, rev is -1, hash/snapshot-id are nil, there
   are no sections, and the timing fields are nil -- never an error."
  [{:keys [state connected? now-ms auth] :as env}]
  (let [now (now-ms)
        a (when (some? auth) (auth))
        v @state
        rev (if (some? v) (:rev v) -1)]
    {:rev rev
     :hash (when (some? v) (st/content-hash v))
     :snapshot-id (when (some? v) (st/snapshot-id v))
     :sections (if (some? v)
                 (mapv #(select-keys % [:level :heading :normalized :occurrence :count])
                       (ops/parse-sections (:content v)))
                 [])
     :remote-idle-ms (when (some? v) (st/remote-idle-ms v now))
     :rev-velocity (when (some? v) (st/rev-velocity v now))
     :rev-known (>= rev 0)
     :connected (boolean (connected?))
     :auth (select-keys (or a {}) [:kind :status :name])
     :writable (writable? env)
     :hint (when (< rev 0)
             "worker is still booting (login/download/socket); call get-status again")}))

;; ---------- 2. read-section ----------

(defn read-section
  "{:heading :occurrence? :level? :includeSubsections?} => {:rev :hash :content
   :start :end}. Scoped read; with :includeSubsections the slice runs to the
   next heading at or above the target's level. writeRoundTrip: false and the
   hint are added ONLY for a subtree read, so the default shape is unchanged."
  [{:keys [state]} {:keys [heading occurrence level includeSubsections]}]
  (when (or (not (string? heading)) (str/blank? heading))
    (throw (err :bad-args {:field :heading :got heading})))
  (let [v @state
        content (:content v)
        sections (ops/parse-sections content)
        opts {:occurrence occurrence :level level}
        {:keys [start end]} (if includeSubsections
                              (ops/subtree-range sections content heading opts)
                              (ops/section-anchor sections content heading opts))]
    (cond-> {:rev (:rev v) :hash (st/content-hash v)
             :content (subs content start end) :start start :end end}
      includeSubsections
      (assoc :writeRoundTrip false
             :hint "subtree read is read-only until subtree writes land: apply-ops new-section-text and append-to-section still replace/append the section body only, so writing this parent body back would drop its child headings"))))

;; ---------- preview + line helpers ----------

(defn- line-of-offset
  "1-based line number of a UTF-16 offset in normalized content."
  [content offset]
  (let [n (min (max 0 offset) (m/utf16-length content))]
    (inc (count (re-seq #"\n" (subs content 0 n))))))

;; Dry-run preview caps: first limit wins, whole lines only (a straddling line
;; is dropped, so a preview never exceeds either bound).
(def ^:private preview-max-units 4000)
(def ^:private preview-max-lines 200)
(def ^:private preview-tail-lines 12)

(defn- window-range
  "1-based [start end] line range of the +-radius window around `at`."
  [content at radius]
  (let [l (line-of-offset content at)
        n (count (str/split-lines content))]
    [(max 1 (- l radius)) (min n (+ l radius))]))

(defn- render-numbered
  "`n | line` for the inclusive 1-based range [lo, hi] of the line vector."
  [lines lo hi]
  (str/join "\n" (map (fn [i] (str i " | " (nth lines (dec i))))
                      (range lo (inc hi)))))

(defn- rendered-units
  "UTF-16 units of one rendered `n | line` entry (the 3 is \" | \")."
  [i line]
  (+ 3 (m/utf16-length (str i)) (m/utf16-length line)))

(defn- cap-forward
  "Whole-line forward cap over [lo, hi]: at most 200 lines or 4000 UTF-16
   units of RENDERED text (line numbers included, so the returned preview
   never exceeds the cap). Returns the kept inclusive range."
  [lines lo hi]
  (let [hi (min hi (count lines))
        lo (max 1 lo)]
    (loop [i lo units 0]
      (cond
        (> i hi) {:lo lo :hi hi}
        (>= (- i lo) preview-max-lines) {:lo lo :hi (dec i)}
        :else
        (let [w (+ (rendered-units i (nth lines (dec i))) (if (= i lo) 0 1))]
          (if (> (+ units w) preview-max-units)
            {:lo lo :hi (dec i)}
            (recur (inc i) (+ units w))))))))

(defn- cap-tail
  "Whole-line backward cap: keep the LAST up-to-12 lines of [lo, hi] that fit
   in 4000 UTF-16 units of rendered text, so `tail` really shows the end of
   the region."
  [lines lo hi]
  (let [hi (min hi (count lines))
        lo (max 1 lo)
        tlo (max lo (- hi (dec preview-tail-lines)))]
    (loop [i hi units 0]
      (cond
        (< i lo) {:lo lo :hi hi}
        (< i tlo) {:lo (inc i) :hi hi}
        :else
        (let [w (+ (rendered-units i (nth lines (dec i))) (if (= i hi) 0 1))]
          (if (> (+ units w) preview-max-units)
            {:lo (inc i) :hi hi}
            (recur (dec i) (+ units w))))))))

(defn preview-window
  "Numbered window of lines around `at`, +-radius. A dry-run at line 300
   must show line 300, not the first 2KB of the document. Success-path
   previews keep this shape unchanged."
  [content at radius]
  (let [lines (vec (str/split-lines content))
        [start end] (window-range content at radius)
        body (map-indexed (fn [i line] (str (+ start i) " | " line))
                          (subvec lines (dec start) end))]
    {:text (str/join "\n" body)
     :start-line start
     :end-line end}))

(defn preview-dry-run
  "Dry-run preview for one `preview` mode. -> {:preview :preview-lines
   :preview-mode :preview-total-lines :preview-truncated}. `span` is an
   affected-span over the resolved ops; the preview is read from the NEW
   content, except a pure delete (empty new span), which previews the lines it
   removes from `old-content`. `window` keeps the six-line radius around
   `target-start`; `region` shows the whole affected range; `tail` shows its
   last 12 lines. Cap: 200 lines or 4000 UTF-16 units of rendered text, first
   limit wins, whole lines only. Pure."
  [mode new-content old-content span target-start]
  (let [{:keys [old-start old-end new-start new-end]} span
        [lines lo hi] (if (> new-end new-start)
                        [ (vec (str/split-lines new-content))
                          (line-of-offset new-content new-start)
                          (line-of-offset new-content (max new-start (dec new-end)))]
                        [ (vec (str/split-lines old-content))
                          (line-of-offset old-content old-start)
                          (line-of-offset old-content (max old-start (dec old-end)))])
        total (max 0 (inc (- hi lo)))
        mode (or mode "window")
        [rlo rhi want] (case mode
                         "window" (let [[s e] (window-range new-content target-start 6)]
                                    [s e (max 0 (inc (- e s)))])
                         "region" [lo hi total]
                         "tail" [(max lo (- hi (dec preview-tail-lines))) hi
                                 (min total preview-tail-lines)]
                         (throw (err :bad-args
                                     {:field :preview :got mode
                                      :allowed ["window" "region" "tail"]})))
        kept (if (= mode "tail")
               (cap-tail lines rlo rhi)
               (cap-forward lines rlo rhi))
        shown (max 0 (inc (- (:hi kept) (:lo kept))))]
    {:preview (if (pos? shown) (render-numbered lines (:lo kept) (:hi kept)) "")
     :preview-lines {:start-line (if (pos? shown) (:lo kept) rlo)
                     :end-line (:hi kept)}
     :preview-mode mode
     :preview-total-lines total
     :preview-truncated (or (< shown total) (< shown want))}))

;; ---------- 2b. read-note ----------

(defn read-note
  "{:offset? :limit? :sections?} => whole/paginated note with line numbers on
   sections. Default: up to 2000 lines. :sections is \"all\" (default),
   \"none\", or \"window\" (only headings whose start offset falls inside the
   returned slice). Front matter is visible here (sections are not)."
  [{:keys [state]} {:keys [offset limit sections]}]
  (when (and (some? offset) (or (not (integer? offset)) (< offset 1)))
    (throw (err :bad-args {:field :offset :got offset :reason :must-be-positive})))
  (when (and (some? limit) (or (not (integer? limit)) (< limit 1)))
    (throw (err :bad-args {:field :limit :got limit :reason :must-be-positive})))
  (let [mode (if (nil? sections) "all" sections)]
    (when-not (contains? #{"all" "none" "window"} mode)
      (throw (err :bad-args {:field :sections :got sections
                             :allowed ["all" "none" "window"]
                             :hint "use \"none\" instead of a boolean"})))
    (let [v @state
          content (:content v)
          lines (vec (str/split-lines content))
          total (count lines)
          start (min (max 1 (or offset 1)) (max 1 total))
          lim (min (or limit 2000) 2000)
          end (min total (+ start (dec lim)))
          slice (if (<= start end) (subvec lines (dec start) end) [])
          slice-text (str/join "\n" slice)
          ;; Slice offsets are computed once; sections are filtered by :start
          ;; instead of rescanning per heading. Line numbers stay absolute.
          slice-start (if (= start 1)
                        0
                        (inc (m/utf16-length
                              (str/join "\n" (subvec lines 0 (dec start))))))
          slice-end (+ slice-start (m/utf16-length slice-text))
          describe (fn [sec]
                     (assoc (select-keys sec [:level :heading :occurrence])
                            :line (line-of-offset content (:start sec))))
          parsed (ops/parse-sections content)
          sections (case mode
                     "none" []
                     "all" (mapv describe parsed)
                     "window" (mapv
                               (fn [sec]
                                 (assoc (select-keys sec [:level :heading :occurrence])
                                        :line (+ (dec start)
                                                 (line-of-offset
                                                  slice-text
                                                  (- (:start sec) slice-start)))))
                               (filter #(and (>= (:start %) slice-start)
                                             (< (:start %) slice-end))
                                       parsed)))]
      {:rev (:rev v)
     :hash (st/content-hash v)
     :doc-length (m/utf16-length content)
     :length (m/utf16-length (str/join "\n" slice))
     :total-lines total
     :start-line start
     :end-line end
       :truncated (< end total)
       :content (str/join "\n" slice)
       :sections sections})))

;; ---------- ack wait (fast path) ----------

(defn- wait-for-rev!
  "Resolve true once state advances past pre-rev, else false at deadline.
   Lets :verify false return quickly without leaving local state stale."
  [state pre-rev deadline now-ms sleep-ms]
  (if (> (:rev @state) pre-rev)
    (js/Promise.resolve true)
    (if (> (now-ms) deadline)
      (js/Promise.resolve false)
      (-> (sleep-ms 25)
          (.then (fn [_] (wait-for-rev! state pre-rev deadline now-ms sleep-ms)))))))

;; ---------- reconnect/retry helpers ----------

(defn wait-for-writable!
  "Connected AND holding a revision learned on this socket generation. A
   reconnect invalidates the rev; writing before the next doc frame would use
   -1 or a stale base."
  [env deadline now-ms sleep-ms]
  (if (and ((:connected? env)) (> (:rev @(:state env)) -1))
    (js/Promise.resolve true)
    (if (> (now-ms) deadline)
      (js/Promise.resolve false)
      (-> (sleep-ms 100)
          (.then (fn [_] (wait-for-writable! env deadline now-ms sleep-ms)))))))

(defn- retry-after-reconnect!
  "Re-emit only when the previous attempt provably did not reach the server
   (send-op rejected pre-emit, or a pre-emit CAS race). Adopting a fresh rev is
   safe only while the content is still the same base; otherwise the ops are
   coordinates into a document that moved, so abort."
  [env args intent state attempt]
  (-> (wait-for-writable! env (+ ((:now-ms env)) 5000)
                          (:now-ms env) (:sleep-ms env))
      (.then (fn [ok?]
               (when-not ok?
                 (throw (err :rev-unknown
                             {:why "no doc frame after reconnect; refusing to reuse old ops"})))
               (let [cur (st/snapshot-for-cas state)]
                 (when (not= (:hash cur) (:base-hash intent))
                   (throw (err :target-moved
                               {:reason :content-changed-before-retry
                                :base-hash (:base-hash intent)
                                :server-hash (:hash cur)})))
                 (emit-with-cas! env args
                                 (assoc intent :base-rev (:rev cur) :base-hash (:hash cur))
                                 (inc attempt)))))))

;; ---------- emit core (async) ----------

(defn- emit-with-cas!
  ([env args intent] (emit-with-cas! env args intent 0))
  ([env args intent attempt]
   (let [{:keys [state send-op! fetch-download get-presence inflight
                 now-ms sleep-ms max-retries]} env
         {:keys [op-id dry-run?]} intent
         snap (st/snapshot-for-cas state)]
     (ops/cas-check snap (:base-rev intent) (:base-hash intent))
     (when (< (:rev snap) 0)
       (throw (err :rev-unknown
                   {:why "revision valid only within the socket generation that learned it"})))
     (let [resolved (ops/resolve-ops (:content snap) args)
           new-content (ops/apply-ops (:content snap) (:ops resolved))]
       (when dry-run?
         (let [span (ops/affected-span (:ops resolved))]
           (throw (ex-info "dry-run preview"
                           (merge {:code :dry-run-preview
                                   :dry-run true
                                   :status :dry-run
                                   :written false
                                   :base-rev (:rev snap)
                                   :base-hash (:hash snap)
                                   :would-be-hash (m/content-hash new-content)
                                   :ops (:ops resolved)
                                   :hint "no write was emitted; rev and hash are the current base"}
                                  (preview-dry-run (:preview args) new-content
                                                   (:content snap) span
                                                   (:target-start resolved)))))))
       (ops/overlap-check (get-presence) (:target-start resolved) (:target-end resolved) (:rev snap))
       (let [fresh @state]
         (when (not= (:rev fresh) (:rev snap))
           (throw (ex-info "stale revision"
                           {:code :stale-revision
                            :base-rev (:base-rev intent) :base-hash (:base-hash intent)
                            :server-rev (:rev fresh)
                            :server-hash (st/content-hash fresh)
                            :reason :rev-moved-pre-emit}))))
       (let [tail (st/tail state)
             wire-ops (cond-> (:ops resolved) (pos? tail) (conj [:retain tail]))
             pre {:snap snap
                  :ops wire-ops
                  :target-start (:target-start resolved)
                  :target-end (:target-end resolved)
                  :heading-or-nil (:heading resolved)
                  :occurrence (:occurrence resolved)
                  :new-content new-content}]
         (when (some? @inflight)
           (throw (err :emit-in-flight {:op-id (:op-id @inflight)})))
         (when (:clear-doc-reset! env) ((:clear-doc-reset! env)))
         (reset! inflight {:pre-rev (:rev snap)
                           :new-content new-content
                           :op-id op-id})
         ;; send-op! can throw synchronously when the socket vanished between
         ;; the connected? check and the emit. Convert it to a rejection so the
         ;; catch below always clears :inflight and applies the retry policy.
         (let [sent (try
                      (send-op! (:rev snap) (:ops pre) nil)
                      (catch :default e
                        (js/Promise.reject e)))]
           (.catch
            (-> sent
                (.then
                 (fn [res]
                  (case (:kind res)
                    :emitted
                    (if (false? (:verify? args))
                      (-> (wait-for-rev! state (:rev snap) (+ (now-ms) 1500)
                                         now-ms sleep-ms)
                          (.then
                           (fn [ok?]
                             ;; A rev advance is not enough for the fast
                             ;; path: a doc/force rejection also moves the
                             ;; rev. Only call it an ack when the mirror holds
                             ;; the intended content.
                             (let [accepted? (and ok? (= (:content @state) new-content))]
                               (when (and (some? inflight)
                                          (= op-id (:op-id @inflight))
                                          (not accepted?))
                                 (reset! inflight nil))
                               {:new-rev (:rev @state)
                                :new-hash (st/content-hash @state)
                                :preview (:text (preview-window (:new-content pre)
                                                                (:target-start pre) 6))
                                :verified (if accepted? :ack :emitted)
                                :via (if accepted? :ack :emitted)
                                :op-id op-id}))))
                      (-> (phase-b-poll! env pre)
                          (.then
                           (fn [poll]
                             (when (and (some? inflight)
                                        (= op-id (:op-id @inflight)))
                               (reset! inflight nil))
                             (if (:ok poll)
                               (do
                                 (when (and (some? @state)
                                            (= (:rev @state) (:rev snap)))
                                   (st/on-ack! state {:rev (inc (:rev snap))
                                                      :new-content new-content}
                                               (now-ms)))
                                 (phase-b-result state pre poll op-id))
                               ;; NO re-emit after an emit. A poll timeout is
                               ;; not proof the op failed: /download can lag,
                               ;; and a concurrent edit can change the region
                               ;; we compare. The old code re-emitted here and
                               ;; could duplicate an append. Re-read instead.
                               (phase-b-result state pre poll op-id))))))

                    (throw (ex-info "bad-transport"
                                    {:reason :unknown-send-op-result :got res}))))))
            (fn [e]
                  (when (and (some? inflight)
                             (= op-id (:op-id @inflight)))
                    (reset! inflight nil))
                  (let [d (ex-data e)
                        code (:code d)]
                    (cond
                      (= :dry-run-preview code)
                      (assoc (dissoc d :code) :dry-run true)

                      (and (= :not-connected code)
                           (< attempt (dec (or max-retries 5))))
                      (retry-after-reconnect! env args intent state attempt)

                      (and (= :stale-revision code)
                           (< attempt (dec (or max-retries 5)))
                           (some? @state)
                           (= (st/content-hash @state) (:hash snap)))
                      (retry-after-reconnect! env args intent state attempt)

                      :else (throw e)))))))))))

;; ---------- 3. apply-ops ----------

(defn apply-ops
  "{:base-rev :base-hash :ops|:new-section-text :heading? :occurrence? :dryRun}
   Dry-run returns {:dry-run true :new-rev :new-hash :preview :ops}."
  [{:keys [connected?] :as env} {:keys [base-rev base-hash dryRun] :as args}]
  (when (or (not (integer? base-rev)) (not (string? base-hash)))
    (throw (err :bad-args {:fields [:base-rev :base-hash] :got args})))
  (write-auth-check! env)
  (when (not (connected?))
    (throw (err :not-connected {})))
  (let [op-id (str (random-uuid))]
    (emit-with-cas! env args {:op-id op-id :base-rev base-rev
                              :base-hash base-hash :dry-run? (boolean dryRun)})))

;; ---------- 4. append-to-section ----------

(defn append-to-section
  "{:heading :base-rev :base-hash :text :occurrence? :dryRun :verify :preview}"
  [{:keys [connected?] :as env} {:keys [heading base-rev base-hash text occurrence
                                        dryRun verify preview]}]
  (when (or (not (string? heading)) (str/blank? heading))
    (throw (err :bad-args {:field :heading :got heading})))
  (when (not (string? text))
    (throw (err :bad-args {:field :text :got text})))
  (when (or (not (integer? base-rev)) (not (string? base-hash)))
    (throw (err :bad-args {:fields [:base-rev :base-hash]})))
  (write-auth-check! env)
  (when (not (connected?))
    (throw (err :not-connected {})))
  (let [snap (st/snapshot-for-cas (:state env))]
    (ops/cas-check snap base-rev base-hash)
    (let [sections (ops/parse-sections (:content snap))
          computed (ops/append-to-section-ops
                    (:content snap) sections heading text {:occurrence occurrence})]
      (emit-with-cas! env
                      {:ops computed :verify? verify :preview preview}
                      {:op-id (str (random-uuid))
                       :base-rev base-rev :base-hash base-hash
                       :dry-run? (boolean dryRun)}))))

;; ---------- 4b. replace-lines ----------

(defn replace-lines
  "{:base-rev :base-hash :edits [{:line :old :new}] :dryRun :verify :preview}
   1-based lines, exact :old match, single-line :new, batch applied bottom-up."
  [{:keys [connected?] :as env} {:keys [base-rev base-hash edits dryRun verify preview]}]
  (when (or (not (integer? base-rev)) (not (string? base-hash)))
    (throw (err :bad-args {:fields [:base-rev :base-hash]})))
  (when (or (not (sequential? edits)) (empty? edits))
    (throw (err :bad-args {:field :edits :got edits})))
  (write-auth-check! env)
  (when (not (connected?))
    (throw (err :not-connected {})))
  (let [snap (st/snapshot-for-cas (:state env))]
    (ops/cas-check snap base-rev base-hash)
    (let [{:keys [ops target-start target-end]}
          (ops/replace-lines->ops (:content snap) edits)]
    (emit-with-cas! env
                    {:ops ops :target-range [target-start target-end]
                     :verify? verify :preview preview}
                      {:op-id (str (random-uuid))
                       :base-rev base-rev :base-hash base-hash
                       :dry-run? (boolean dryRun)}))))

(defn insert-lines
  "{:base-rev :base-hash :line :text :dryRun :verify :preview} insert before line."
  [{:keys [connected?] :as env} {:keys [base-rev base-hash line text dryRun verify preview]}]
  (when (or (not (integer? base-rev)) (not (string? base-hash)))
    (throw (err :bad-args {:fields [:base-rev :base-hash]})))
  (write-auth-check! env)
  (when (not (connected?))
    (throw (err :not-connected {})))
  (let [snap (st/snapshot-for-cas (:state env))]
    (ops/cas-check snap base-rev base-hash)
    (let [{:keys [ops target-start target-end]}
          (ops/insert-lines->ops (:content snap) line text)]
      (emit-with-cas! env
                      {:ops ops :target-range [target-start target-end]
                       :verify? verify :preview preview}
                      {:op-id (str (random-uuid))
                       :base-rev base-rev :base-hash base-hash
                       :dry-run? (boolean dryRun)}))))

(defn delete-lines
  "{:base-rev :base-hash :line :count? :dryRun :verify :preview} delete lines."
  [{:keys [connected?] :as env} {:keys [base-rev base-hash line count dryRun verify preview]}]
  (when (or (not (integer? base-rev)) (not (string? base-hash)))
    (throw (err :bad-args {:fields [:base-rev :base-hash]})))
  (write-auth-check! env)
  (when (not (connected?))
    (throw (err :not-connected {})))
  (let [snap (st/snapshot-for-cas (:state env))]
    (ops/cas-check snap base-rev base-hash)
    (let [{:keys [ops target-start target-end]}
          (ops/delete-lines->ops (:content snap) line (or count 1))]
      (emit-with-cas! env
                      {:ops ops :target-range [target-start target-end]
                       :verify? verify :preview preview}
                      {:op-id (str (random-uuid))
                       :base-rev base-rev :base-hash base-hash
                       :dry-run? (boolean dryRun)}))))

(defn search
  "{:query :regex :caseSensitive :limit?} -> matching lines with numbers."
  [{:keys [state]} {:keys [query regex caseSensitive limit]}]
  (when (or (not (string? query)) (str/blank? query))
    (throw (err :bad-args {:field :query :got query})))
  (when (> (m/utf16-length query) 200)
    (throw (err :bad-args {:field :query :reason :too-long :max 200})))
  (when (and (some? limit) (or (not (integer? limit)) (< limit 1)))
    (throw (err :bad-args {:field :limit :got limit :reason :must-be-positive})))
  (let [v @state
        lines (vec (str/split-lines (:content v)))
        lim (min (or limit 50) 500)
        cs? (boolean caseSensitive)
        re (when regex
             (try (js/RegExp. query (if cs? "" "i"))
                  (catch :default _e
                    (throw (err :bad-args {:field :query :reason :bad-regex})))))
        hit? (if regex
               (fn [line] (.test re line))
               (fn [line]
                 (if cs?
                   (str/includes? line query)
                   (str/includes? (str/lower-case line) (str/lower-case query)))))
        hits (loop [i 0 acc []]
               (if (or (>= i (count lines)) (>= (count acc) lim))
                 acc
                 (let [line (nth lines i)]
                   (recur (inc i)
                          (if (hit? line)
                            (conj acc {:line (inc i) :text line})
                            acc)))))]
    {:rev (:rev v)
     :hash (st/content-hash v)
     :query query
     :matches hits
     :truncated (>= (count hits) lim)}))

;; ---------- 5. presence (advisory only) ----------

(defn presence
  "=> {:users :rev-velocity :remote-idle-ms :selections}. Read-only heuristic."
  [{:keys [state get-presence now-ms]}]
  (let [now (now-ms)
        v @state
        p (get-presence)]
    {:users (:users p)
     :rev-velocity (st/rev-velocity v now)
     :remote-idle-ms (st/remote-idle-ms v now)
     :selections (:selections p)}))

;; ---------- gated whole-doc set-note (not one of the 5) ----------

(defn set-note
  "Whole-doc replace ONLY via {:force true :reason :base-rev :base-hash}."
  [env {:keys [force reason base-rev base-hash content]}]
  (when (not (and (true? force) (string? reason) (not (str/blank? reason))))
    (throw (err :refused {:reason "set-note needs {:force true :reason ...}"})))
  (when (or (not (integer? base-rev)) (not (string? base-hash)) (not (string? content)))
    (throw (err :bad-args {:fields [:base-rev :base-hash :content]})))
  (when (not ((:connected? env)))
    (throw (err :not-connected {})))
  (write-auth-check! env)
  (let [snap (st/snapshot-for-cas (:state env))]
    (ops/cas-check snap base-rev base-hash)
    (emit-with-cas! env {:ops (ops/content->ops (:content snap) (m/normalize content))}
                    {:op-id (str (random-uuid))
                     :base-rev base-rev :base-hash base-hash :dry-run? false})))
