(ns hedgedoc-mcp.core
  "T8 wiring + stdio entrypoint (Squint/Node ESM).

   What this file owns (SPEC section 3, `core.cljs` row):
   env config, one keywordizing JSON codec over readline stdio, JSON-RPC
   dispatch (initialize / tools/list / tools/call), state atom + transport
   callbacks -> state transitions, the tools effect env, and graceful shutdown.

   What it does NOT own: pure calcs (model / model-ops), socket framing
   (transport), value transitions (state), sync test-harness tool logic (tools).

   Sync/async seam (read before touching the write path):
   tools.cljs invokes its env effects (:send-op! :fetch-download :sleep-ms)
   synchronously and dereferences their results inline. Against a live socket
   that is impossible: ack/doc-force/info arrive on later socket events and
   /download is an HTTP round trip. Blocking Node to fake synchrony
   (deasync, Atomics over a worker socket) was rejected: it fights the
   runtime and hides races the adapter must surface. So this file splits:
     - every tool delegates to tools/*; this file owns process state
       (config, state atom, presence, in-flight intent), stdio, arg
       validation, and the transport callbacks. One write implementation
       lives in tools.cljs (CAS -> overlap -> emit -> poll).

   Wire-format notes (HedgeDoc 1.x, socket.io):
   - Internal ops are tagged pairs [:retain n] / [:delete n] / [:insert s].
     The wire uses ot-text JSON: number = retain, string = insert,
     {:d n} = delete count. ops->wire converts on emit; wire-op->ops
     converts remote ops on receipt. Both delete shapes (-n and {:d n}) are
     accepted; this client sends -n. See docs/PROTOCOL.md.
   - selection is always nil on emit (-> JSON null, never undefined).
   - Remote `operation` rev is treated as the post-apply rev (standard OT
     broadcast); mismatch with this assumption surfaces as apply failure
     followed by a /download resync, never silent corruption.
   - /download carries no rev. Boot seeds rev -1 (unknown, integer-typed)
     from /download; the first socket DOC frame rebuilds to the true rev.
     Writes before connect fail :not-connected; reads report rev -1."
  (:require [clojure.string :as str]
            [hedgedoc-mcp.errors :as errors]
            [hedgedoc-mcp.model :as m]
            [hedgedoc-mcp.model-ops :as ops]
            [hedgedoc-mcp.state :as st]
            [hedgedoc-mcp.tools :as tools]
            [hedgedoc-mcp.transport :as t]
            [hedgedoc-mcp.schema :as schema]
            ["node:readline" :as rl]
            ["squint-cljs/src/squint/core.js" :as core]))

;; ---------------- constants ----------------

(def server-name "hedgedoc-mcp")
(def server-version "0.2.2")
(def mcp-protocol-version "2024-11-05")

(def default-idle-ms 30000)
(def poll-ms-default 500)
(def poll-timeout-ms-default 10000)
(def max-retries-default 5)
(def preview-chars-default 2000)

;; ---------------- process-level atoms ----------------

(defonce cfg_ (atom nil))
(defonce env_ (atom nil))
(defonce state_ (atom nil))
(defonce presence_ (atom {:users [] :selections []}))
(defonce rl_ (atom nil))
(defonce shut_ (atom false))
(defonce last-info_ (atom nil))
(defonce booting_ (atom false))
;; One emit in flight at a time: {:pre-rev :new-content :op-id}.
;; Set by tools/emit-with-cas! before the emit, adopted by on-ack!.
(defonce inflight_ (atom nil))
;; Set when a doc frame arrives during an in-flight write with different
;; content: the server rejected the op. Tools retry from the fresh frame.
(defonce doc-reset_ (atom nil))
;; Live session cookie (env value or fetched from /download). Mutable:
;; sessions rotate and expire, and prod must not depend on a pasted string.
(defonce cookie_ (atom nil))
;; {:kind :user|:guest|:unknown :id :name :checked-at} from GET /me.
(defonce auth_ (atom {:kind :unknown}))
;; Bounded cookie-refresh loop: a present-but-invalid cookie must not brick
;; the socket (expiry is a scheduled failure; the dev box proves it).
(defonce cookie-refresh-in-flight_ (atom false))
(defonce cookie-refresh-count_ (atom 0))
;; One 401 refresh per successful request. Without this, a private note and no
;; credentials made refresh-session! -> fetch-download -> 401 -> refresh ...
;; loop forever at boot.
(defonce session-refresh-count_ (atom 0))

(declare boot!)
(declare connect-t!)

;; ---------------- config ----------------

(defn- env-get [k]
  (aget (.-env js/process) k))

(defn- parse-int-or [s dflt]
  (let [n (js/parseInt (str s) 10)]
    (if (js/isNaN n) dflt n)))

(defn- env-flag? [k]
  (let [v (env-get k)
        s (str/lower-case (str (or v "")))]
    (or (= s "1") (= s "true") (= s "yes"))))

(defn- read-config []
  (let [url (env-get "HEDGEDOC_URL")
        note-id (env-get "HEDGEDOC_NOTE_ID")
        idle-ms (parse-int-or (env-get "HEDGEDOC_IDLE_MS") default-idle-ms)
        cookie (env-get "HEDGEDOC_COOKIE")
        email (or (env-get "HEDGEDOC_EMAIL") (env-get "HEDGEDOC_USER"))
        password (env-get "HEDGEDOC_PASSWORD")
        poll-timeout (parse-int-or (env-get "HEDGEDOC_POLL_TIMEOUT_MS") poll-timeout-ms-default)
        poll-ms (parse-int-or (env-get "HEDGEDOC_POLL_MS") poll-ms-default)
        transports (vec (remove str/blank? (str/split (str (or (env-get "HEDGEDOC_TRANSPORTS") "websocket")) #",")))
        client-major (parse-int-or (env-get "HEDGEDOC_CLIENT_MAJOR") 4)]
    (when (or (nil? url) (str/blank? (str url)))
      (throw (ex-info "missing HEDGEDOC_URL" {:code :bad-config :field "HEDGEDOC_URL"})))
    (when (or (nil? note-id) (str/blank? (str note-id)))
      (throw (ex-info "missing HEDGEDOC_NOTE_ID" {:code :bad-config :field "HEDGEDOC_NOTE_ID"})))
    (let [parsed (js/URL. (str url))
          origin (str (.-protocol parsed) "//" (.-host parsed))
          path (str/replace (.-pathname parsed) #"/+$" "")]
    {:base-url (str origin path)
     :origin origin
     :base-path path
     :note-id (str note-id)
     :idle-ms idle-ms
     :client-major client-major
     :poll-timeout-ms poll-timeout
     :poll-ms poll-ms
     :transports transports
     :enable-set-note? (env-flag? "HEDGEDOC_ENABLE_SET_NOTE")
     :allow-guest-writes? (env-flag? "HEDGEDOC_ALLOW_GUEST_WRITES")
     :email (when (and (some? email) (not (str/blank? (str email)))) (str email))
     :password (when (and (some? password) (not (str/blank? (str password)))) (str password))
     :cookie (when (and (some? cookie) (not (str/blank? (str cookie))))
               (str cookie))})))

(defn- download-url [cfg]
  (str (:base-url cfg) "/" (:note-id cfg) "/download"))

;; ---------------- codec: the one keywordizing path ----------------
;; Every inbound stdio line passes decode-line; every outbound protocol
;; message passes encode-msg via send!. Nothing else parses or prints JSON.

(defn- decode-line [line]
  (t/js->clj-kw (js/JSON.parse line)))

(defn- encode-msg [msg]
  (js/JSON.stringify (clj->js msg)))

(defn- send! [msg]
  (.write (.-stdout js/process) (str (encode-msg msg) "\n")))

(defn- reply-ok [id result]
  (send! {:jsonrpc "2.0" :id id :result result}))

(defn- reply-err [id code message data]
  (send! {:jsonrpc "2.0" :id id :error {:code code :message message :data data}}))

(defn- log-err [s]
  (.write (.-stderr js/process) (str s "\n")))

;; ---------------- clocks ----------------

(defn- now-ms []
  (.now js/Date))

(defn- sleep-p [ms]
  (js/Promise. (fn [resolve _reject] (js/setTimeout resolve ms))))

(defn- rand-int* [n]
  (js/Math.floor (* (js/Math.random) n)))

;; ---------------- /download effect ----------------

(defn- capture-cookie!
  "Adopt connect.sid from a response. With force? false, only when we have
   none, so normal traffic does not churn the session."
  [res force?]
  (when (or force? (nil? @cookie_))
    (try
      (let [hdrs (.-headers res)
            arr (if (some? (.-getSetCookie hdrs))
                  (.getSetCookie hdrs)
                  (let [v (.get hdrs "set-cookie")]
                    (if v #js [v] #js [])))]
        (doseq [line arr]
          (let [pair (first (str/split (str line) #";"))]
            (when (str/starts-with? pair "connect.sid=")
              (reset! cookie_ pair)
              (log-err "cookie: adopted connect.sid from response")))))
      (catch :default _e nil)))
  nil)

(defn- fetch-download-attempt
  [attempt]
  (let [cfg @cfg_
        headers (if (some? @cookie_)
                  #js {:Cookie @cookie_}
                  #js {})]
    (-> (js/fetch (download-url cfg) #js {:headers headers})
        (.then (fn [res]
                 (capture-cookie! res false)
                 (cond
                   (.-ok res)
                   (do (reset! session-refresh-count_ 0)
                       (.text res))

                   (and (= 401 (.-status res)) (zero? attempt)
                        (< @session-refresh-count_ 1))
                   (do (swap! session-refresh-count_ inc)
                       (log-err "download: 401, retrying with a fresh session")
                       (-> (refresh-session! "download-401")
                           (.then (fn [_] (fetch-download-attempt 1)))))

                   (= 401 (.-status res))
                   (throw (ex-info "download unauthorized (HTTP 401)"
                                   {:code :unauthorized :status 401}))

                   :else
                   (throw (ex-info (str "download failed: HTTP " (.-status res))
                                   {:code :download-failed
                                    :status (.-status res)}))))))))

(defn- fetch-download []
  (-> (fetch-download-attempt 0)
      (.then (fn [text] {:content (str text)}))))

(defn- check-auth!
  "GET /me: {:status \"ok\", :id, :name} for a registered session the server
   will let into a note room; anything else is a guest we must not write as."
  []
  (let [cfg @cfg_
        headers (if (some? @cookie_)
                  #js {:Cookie @cookie_}
                  #js {})
        handle (fn [body]
                 (let [m (t/js->clj-kw body)
                       user? (and (= "ok" (:status m)) (some? (:id m)))]
                   (reset! auth_
                           (cond-> {:kind (if user? :user :guest)
                                    :status (:status m)
                                    :checked-at (now-ms)}
                             user? (assoc :id (:id m) :name (:name m))))
                   (log-err (str "auth: "
                                 (if user?
                                   (str "registered " (:name m))
                                   (str "guest ("
                                        (or (:status m) "no status")
                                        ")"))))
                   nil))]
    (-> (js/fetch (str (:base-url cfg) "/me") #js {:headers headers})
        (.then (fn [res]
                 (capture-cookie! res false)
                 (.then (.json res) handle)))
        (.catch (fn [e]
                  (reset! auth_ {:kind :unknown :checked-at (now-ms)})
                  (log-err (str "auth: check failed (" (errors/err-message e) ")"))
                  nil)))))

(defn- has-credentials? []
  (and (some? (:email @cfg_)) (some? (:password @cfg_))))

(defn- login!
  "POST /login with the configured credentials and adopt the session cookie.
   Never log the password or the email."
  []
  (let [cfg @cfg_
        params (js/URLSearchParams.)]
    (.append params "email" (:email cfg))
    (.append params "password" (:password cfg))
    (-> (js/fetch (str (:base-url cfg) "/login")
                  #js {:method "POST"
                       :redirect "manual"
                       :headers #js {:Content-Type "application/x-www-form-urlencoded"}
                       :body (.toString params)})
        (.then (fn [res]
                 (capture-cookie! res true)
                 (log-err (str "login: HTTP " (.-status res)
                               " cookie " (if (some? @cookie_) "adopted" "missing")))
                 nil))
        (.catch (fn [e]
                  (log-err (str "login: failed (" (errors/err-message e) ")"))
                  nil))
        (.then (fn [_]
                 (-> (check-auth!)
                     (.then (fn [_]
                              (when (not= :user (:kind @auth_))
                                (log-err (str "login: failed (session is guest; "
                                              "check HEDGEDOC_EMAIL / HEDGEDOC_PASSWORD)")))
                              nil))))))))

(defn- refresh-session!
  "One place to recover a dead session: re-login when credentials exist,
   otherwise let /download mint a fresh guest session."
  [why]
  (log-err (str "session: refresh (" why ")"))
  (reset! cookie_ nil)
  (if (has-credentials?)
    (login!)
    (fetch-download)))

(defn- ensure-session!
  "With credentials, log in when we have no usable user session. Without,
   /download adopts a guest session as before."
  []
  (if (and (has-credentials?)
           (not= :user (:kind @auth_)))
    (login!)
    (js/Promise.resolve true)))

(defn- ensure-state! [content]
  (when (nil? @state_)
    (let [n (m/normalize content)]
      (reset! state_ (st/make-initial (:note-id @cfg_) -1 n (now-ms)))
      (st/set-tail! state_ (- (m/utf16-length content) (m/utf16-length n))))))

(defn- resync-from-download! [why]
  (let [had-state (some? @state_)]
    (-> (fetch-download)
        (.then (fn [got]
                 (let [n (m/normalize (:content got))]
                   (if (nil? @state_)
                     (reset! state_ (st/make-initial (:note-id @cfg_) -1 n (now-ms)))
                     ;; /download has no rev, so the rev is now unknown. A doc
                     ;; frame is the only way to learn it again; without one,
                     ;; every write would fail :rev-unknown forever.
                     (st/on-rebuild! state_ {:rev -1 :new-content n} (now-ms)))
                   (st/set-tail! state_ (- (m/utf16-length (:content got))
                                           (m/utf16-length n))))
                 (log-err (str "resync (" why "): state now rev " (:rev @state_)))
                 (when (and had-state (t/connected?) (not= why "socket-connect"))
                   (log-err "resync: reconnecting for a doc frame")
                   (connect-t!))
                 nil))
        (.catch (fn [e]
                  ;; A failed resync must not leave a stale rev usable: the
                  ;; content may have moved and CAS would pass against the old
                  ;; hash. -1 forces a doc frame before the next write.
                  (when (some? @state_) (st/invalidate-rev! state_))
                  (log-err (str "resync (" why ") failed: " (errors/err-message e)))
                  (when (t/connected?) (connect-t!))
                  nil)))))

(defn- on-connect-error!
  "A stale/invalid session cookie kills the room join with a plain error.
   Drop it, adopt a fresh one from /download, and reconnect (bounded)."
  [err]
  (let [msg (str/lower-case (str (errors/err-message err)))]
    (log-err (str "socket: connect_error " (errors/err-message err)))
    (when (and (or (str/includes? msg "cookie is invalid")
                   (str/includes? msg "auth failed"))
               (not @cookie-refresh-in-flight_)
               (< @cookie-refresh-count_ 3))
      (reset! cookie-refresh-in-flight_ true)
      (log-err "socket: refreshing session after auth failure")
      (-> (refresh-session! "socket-auth")
          (.then (fn [_]
                   (swap! cookie-refresh-count_ inc)
                   (connect-t!)))
          (.catch (fn [e]
                    (log-err (str "socket: cookie refresh failed ("
                                  (errors/err-message e) ")"))))
          (.finally (fn [] (reset! cookie-refresh-in-flight_ false)))))))

(defn- on-connect!
  "Fires on first connect and after every socket.io reconnect. Re-verify the
   session (cookies rotate/expire) and recover state if we have none."
  [_frame]
  (log-err "socket: connect")
  (check-auth!)
  (when (nil? @state_)
    (resync-from-download! "socket-connect"))
  nil)

;; ---------------- op format conversion ----------------
;; Internal: [:retain n] / [:delete n] / [:insert s].
;; Wire (ot-text JSON): number / {:d n} / string. Tagged 2-sequences
;; ([\"retain\" n] etc, as MCP callers send over JSON) are accepted on
;; input for robustness.

(defn- component->op [c code]
  (let [bad (fn [why] (throw (ex-info (str "bad op component: " why)
                                      {:code code :got c})))]
    (cond
      (number? c)
      (cond
        (pos? c) (do (when (not (.isInteger js/Number c)) (bad "retain not an integer"))
                     [:retain c])
        (neg? c) [:delete (- c)]
        :else (bad "zero is not a valid op"))

      (string? c)
      [:insert c]

      (map? c)
      (let [n (or (:d c) (:delete c))]
        (when (or (nil? n) (not (.isInteger js/Number n))) (bad "delete needs integer :d"))
        (when (< n 0) (bad "negative delete"))
        [:delete n])

      (sequential? c)
      (let [v (vec c)]
        (when (not (= 2 (count v))) (bad "pair needs [tag value]"))
        (let [tag (first v) a (second v)]
          (cond
            (or (= tag "retain") (= tag :retain))
            (do (when (not (.isInteger js/Number a)) (bad "retain not an integer"))
                (when (< a 0) (bad "negative retain"))
                [:retain a])

            (or (= tag "delete") (= tag :delete))
            (do (when (not (.isInteger js/Number a)) (bad "delete not an integer"))
                (when (< a 0) (bad "negative delete"))
                [:delete a])

            (or (= tag "insert") (= tag :insert))
            (do (when (not (string? a)) (bad "insert needs a string"))
                [:insert a])

            :else (bad "unknown tag"))))

      :else (bad "component must be number/string/map/pair"))))

(defn- normalize-op-list [raw code]
  (when (not (sequential? raw))
    (throw (ex-info "ops must be an array" {:code code :field :ops :got raw})))
  (let [v (vec raw)]
    (when (empty? v)
      (throw (ex-info "ops must be non-empty" {:code code :field :ops})))
    (mapv (fn [c] (component->op c code)) v)))

(defn- ops->wire [op-list]
  (clj->js
   (mapv (fn [pair]
           (let [op (first pair) a (second pair)]
             (case op
               :retain a
               :insert a
               :delete (- a)
               (throw (ex-info "unknown op" {:code :bad-op :op pair})))))
         op-list)))

(defn- wire-op->ops [wire]
  (when (not (sequential? wire))
    (throw (ex-info "remote op not a sequence" {:code :bad-remote-op :got wire})))
  (mapv (fn [c] (component->op c :bad-remote-op)) (vec wire)))

;; ---------------- presence (advisory only; never a gate) ----------------
;; Cursor/selection shape is not fully characterised (docs/PROTOCOL.md). We
;; keep the latest convertible selection and the raw client list; the overlap
;; check treats absence as no-overlap. No synthesized users, no fake ranges.

(defn- record-selection! [rev sel]
  (try
    (let [s (when (some? sel) (t/js->clj-kw sel))
          entry (cond
                  (and (map? s)
                       (.isInteger js/Number (:start s))
                       (.isInteger js/Number (:end s)))
                  {:rev rev :start (:start s) :end (:end s)}

                  (and (sequential? s)
                       (= 2 (count s))
                       (.isInteger js/Number (first s))
                       (.isInteger js/Number (second s)))
                  {:rev rev :start (first s) :end (second s)}

                  :else nil)]
      (swap! presence_ (fn [p] (assoc p :selections (if (some? entry) [entry] [])))))
    (catch :default _e
      (swap! presence_ (fn [p] (assoc p :selections []))))))

;; ---------------- pending-ack bridge ----------------
;; send-op-async! emits one op and resolves with the server verdict:
;; {:kind :ack :rev} | {:kind :doc-force :rev :content} | {:kind :info ...}.
;; At most one emit in flight: a second emit while pending rejects
;; :emit-in-flight rather than risk a duplicate (opId is client-only;
;; the server has no dedupe, SPEC section 5).

;; ---------------- transport callbacks -> state transitions ----------------

(defn- on-doc! [frame]
  (try
    (let [rev (:rev frame) content (:content frame) clients (:clients frame)]
      (when (or (not (.isInteger js/Number rev)) (not (string? content)))
        (throw (ex-info "malformed doc frame" {:code :bad-doc-frame :frame frame})))
      (reset! cookie-refresh-count_ 0)
      (swap! presence_ (fn [p] (assoc p :users (vec (or clients [])))))
      (let [n (m/normalize content)
            inf @inflight_]
        (when (and (some? inf) (not= (:new-content inf) n))
          (reset! inflight_ nil)
          (reset! doc-reset_ (now-ms))
          (log-err "socket: doc rejected in-flight write; tools will retry"))
        (if (nil? @state_)
          (reset! state_ (st/make-initial (:note-id @cfg_) rev n (now-ms)))
          (st/on-rebuild! state_ {:rev rev :new-content n} (now-ms)))
        (st/set-tail! state_ (- (m/utf16-length content) (m/utf16-length n))))
      (log-err (str "socket: doc rev " (:rev @state_))))
    (catch :default e
      (log-err (str "socket: doc frame ignored: " (errors/err-message e))))))

(defn- on-operation! [msg]
  (try
    (record-selection! (:rev msg) (:selection msg))
    (let [cur @state_]
      (if (nil? cur)
        (log-err "socket: remote op before boot truth; ignoring")
        (let [internal (wire-op->ops (:ops msg))
              ;; The wire base includes the server's extra trailing newlines
              ;; (the local mirror keeps them as :tail). Fold against the raw
              ;; form, then normalize and recompute the tail.
              raw (str (:content cur) (apply str (repeat (st/tail state_) "\n")))
              new-raw (ops/apply-ops-raw raw internal)
              new-content (m/normalize new-raw)]
          (st/on-remote-operation! state_ {:rev (:rev msg) :new-content new-content} (now-ms))
          (st/set-tail! state_ (- (m/utf16-length new-raw) (m/utf16-length new-content))))))
    (catch :default e
      (log-err (str "socket: remote op failed (" (errors/err-message e) "); resyncing from /download"))
      (resync-from-download! "remote-op-failed"))))

(defn- on-ack!
  "Our own op was positioned at (:rev msg). Adopt it: the ack is the rev
   echo, so local state must advance or every following CAS is stale.
   An ack that cannot be ours falls back to /download ground truth."
  [msg]
  (let [rev (:rev msg)
        inf @inflight_]
    (log-err (str "socket: ack rev " rev))
    ;; Any ack at or after our base+1 means our emit was positioned. Clear
    ;; :inflight even when the rev jumped (a remote op landed first); leaving it
    ;; set made every later write fail :emit-in-flight until a reconnect.
    (when (and (some? inf) (>= rev (inc (:pre-rev inf))))
      (reset! inflight_ nil))
    (cond
      (and (some? inf) (= rev (inc (:pre-rev inf))))
      (if (and (some? @state_) (= (:rev @state_) (:pre-rev inf)))
        (st/on-ack! state_ {:rev rev :new-content (:new-content inf)} (now-ms))
        ;; We already moved past the pre-rev: do not overwrite newer
        ;; content with our stale intent; take ground truth instead.
        (resync-from-download! "ack-not-adoptable"))

      (and (some? @state_) (not (= rev (:rev @state_))))
      (resync-from-download! "unsolicited-ack"))))

(defn- on-force! [frame]
  (try
      (let [rev (:rev frame) content (:content frame)]
        (when (or (not (.isInteger js/Number rev)) (not (string? content)))
          (throw (ex-info "malformed force frame" {:code :bad-doc-frame :frame frame})))
        (let [n (m/normalize content)
              inf @inflight_]
          ;; A forced rebuild that does not contain our intended result means
          ;; the server rejected/rebased the op. Clear the guard so the next
          ;; write can proceed; the waiting tool sees content != intent.
          (when (and (some? inf) (not= (:new-content inf) n))
            (reset! inflight_ nil)
            (reset! doc-reset_ (now-ms))
            (log-err "socket: force rejected in-flight write"))
          (if (nil? @state_)
            (reset! state_ (st/make-initial (:note-id @cfg_) rev n (now-ms)))
            (st/on-rebuild! state_ {:rev rev :new-content n} (now-ms))))
        (log-err (str "socket: force rebuild to rev " rev)))
      (catch :default e
        (log-err (str "socket: force frame ignored: " (errors/err-message e))))))

(defn- on-info! [msg]
  (reset! last-info_ msg)
  (log-err (str "socket: info code=" (or (:code msg) "?"))))

;; ---------------- tools effect env ----------------
;; Every tool consumes this env. :send-op! accepts INTERNAL tagged ops and
;; converts to wire form at the single seam. :inflight is the ack bridge:
;; tools records the intent, on-ack! adopts the server rev.

(defn- make-env [cfg]
  {:state state_
   :inflight inflight_
   :auth (fn [] @auth_)
   :doc-reset (fn [] @doc-reset_)
   :clear-doc-reset! (fn [] (reset! doc-reset_ nil))
   :allow-guest-writes? (:allow-guest-writes? cfg)
   :connected? (fn [] (t/connected?))
   :now-ms now-ms
   :send-op! (fn [rev internal-ops _sel] (t/send-op! rev (ops->wire internal-ops) nil))
   :fetch-download fetch-download
   :get-presence (fn [] @presence_)
   :sleep-ms sleep-p
   :rand-int rand-int*
   :max-retries max-retries-default
   :preview-chars preview-chars-default
   :poll-ms (:poll-ms cfg)
   :poll-timeout-ms (:poll-timeout-ms cfg)
   :idle-ms (:idle-ms cfg)
   :config cfg})

;; ---------------- arg validation (spec table for tools/call) ----------------

(defn- checked-int [args k]
  (let [v (get args k)]
    (when (not (.isInteger js/Number v))
      (throw (ex-info (str "bad arg " k ": integer required")
                      {:code :bad-args :field k :got v})))
    v))

(defn- checked-str [args k]
  (let [v (get args k)]
    (when (or (not (string? v)) (str/blank? v))
      (throw (ex-info (str "bad arg " k ": non-blank string required")
                      {:code :bad-args :field k :got v})))
    v))

(defn- checked-occurrence [args]
  (let [o (:occurrence args)]
    (when (some? o)
      (when (or (not (.isInteger js/Number o)) (< o 0))
        (throw (ex-info "bad arg occurrence: non-negative integer required"
                        {:code :bad-args :field :occurrence :got o}))))
    o))

(defn- require-state! [env]
  (when (nil? @(:state env))
    ;; Self-heal: an MCP process outlives backend restarts. If boot never
    ;; landed (backend was down), kick it again rather than staying dead.
    (when-not @booting_ (boot!))
    (throw (ex-info "no boot truth yet (download and socket both pending)"
                    {:code :not-booted
                     :hint "boot retry started; call again in a few seconds"}))))

(defn- connected-check! [env]
  (when (not ((:connected? env)))
    (throw (ex-info "not connected" {:code :not-connected}))))

;; ---------------- tool handlers ----------------
;; Each takes keywordized arguments, returns data or a Promise of data.
;; execute-tool wraps both into the MCP result envelope.

(defn- checked-wait-ms [args]
  (let [v (:waitMs args)]
    (cond
      (nil? v) 0
      (and (.isInteger js/Number v) (>= v 0) (<= v 15000)) v
      :else (throw (ex-info "bad arg waitMs: integer 0..15000 required"
                            {:code :bad-args :field :waitMs :got v})))))

(defn- handle-get-status [args]
  (let [env @env_
        wait-ms (checked-wait-ms args)
        started ((:now-ms env))]
    ;; A cold worker must not answer :not-booted here. Kick boot, then wait
    ;; (or return at once for waitMs 0). The wait REPLACES require-state! for
    ;; this handler: a timeout returns the nil-tolerant status, not an error.
    (when (nil? @(:state env))
      (when-not @booting_ (boot!)))
    (if (zero? wait-ms)
      (assoc (tools/get-status env) :waitedMs 0)
      (-> (tools/wait-for-writable! env (+ started wait-ms)
                                    (:now-ms env) (:sleep-ms env))
          (.then (fn [_ok?]
                   (assoc (tools/get-status env)
                          :waitedMs (- ((:now-ms env)) started))))))))

(defn- checked-level [args]
  (let [v (:level args)]
    (when (some? v)
      (when (or (not (.isInteger js/Number v)) (< v 1) (> v 6))
        (throw (ex-info "bad arg level: integer 1..6 required"
                        {:code :bad-args :field :level :got v}))))
    v))

(defn- handle-read-section [args]
  (let [env @env_]
    (require-state! env)
    (tools/read-section env {:heading (checked-str args :heading)
                             :occurrence (checked-occurrence args)
                             :level (checked-level args)
                             :includeSubsections (true? (:includeSubsections args))})))

(defn- handle-read-note [args]
  (let [env @env_
        offset (let [v (:offset args)]
                 (when (some? v)
                   (when (or (not (.isInteger js/Number v)) (< v 1))
                     (throw (ex-info "offset must be a positive integer"
                                     {:code :bad-args :field :offset :got v}))))
                 v)
        limit (let [v (:limit args)]
                (when (some? v)
                  (when (or (not (.isInteger js/Number v)) (< v 1))
                    (throw (ex-info "limit must be a positive integer"
                                    {:code :bad-args :field :limit :got v}))))
                v)]
    (require-state! env)
    (tools/read-note env {:offset offset :limit limit
                          :sections (:sections args)})))

(defn- handle-replace-lines [args]
  (let [env @env_
        base-rev (checked-int args :base-rev)
        base-hash (checked-str args :base-hash)
        edits (:edits args)]
    (when (or (not (sequential? edits)) (empty? edits))
      (throw (ex-info "edits must be a non-empty array"
                      {:code :bad-args :field :edits :got edits})))
    (require-state! env)
    (connected-check! env)
    (tools/replace-lines env {:base-rev base-rev :base-hash base-hash
                              :edits edits
                              :preview (:preview args)
                              :dryRun (boolean (:dryRun args))
                              :verify (if (contains? args :verify)
                                      (boolean (:verify args))
                                      true)})))

(defn- handle-insert-lines [args]
  (let [env @env_
        base-rev (checked-int args :base-rev)
        base-hash (checked-str args :base-hash)
        line (checked-int args :line)
        text (:text args)]
    (when-not (string? text)
      (throw (ex-info "text must be a string"
                      {:code :bad-args :field :text :got text})))
    (require-state! env)
    (connected-check! env)
    (tools/insert-lines env {:base-rev base-rev :base-hash base-hash
                             :line line :text text
                             :preview (:preview args)
                             :dryRun (boolean (:dryRun args))
                             :verify (if (contains? args :verify)
                                        (boolean (:verify args))
                                        true)})))

(defn- handle-delete-lines [args]
  (let [env @env_
        base-rev (checked-int args :base-rev)
        base-hash (checked-str args :base-hash)
        line (checked-int args :line)
        count (let [v (:count args)]
                (when (some? v)
                  (when (or (not (.isInteger js/Number v)) (< v 1))
                    (throw (ex-info "count must be a positive integer"
                                    {:code :bad-args :field :count :got v}))))
                v)]
    (require-state! env)
    (connected-check! env)
    (tools/delete-lines env {:base-rev base-rev :base-hash base-hash
                             :line line :count count
                             :preview (:preview args)
                             :dryRun (boolean (:dryRun args))
                             :verify (if (contains? args :verify)
                                        (boolean (:verify args))
                                        true)})))

(defn- handle-search [args]
  (let [env @env_
        query (checked-str args :query)
        limit (let [v (:limit args)]
                (when (some? v)
                  (when (or (not (.isInteger js/Number v)) (< v 1) (> v 500))
                    (throw (ex-info "limit must be 1..500"
                                    {:code :bad-args :field :limit :got v}))))
                v)]
    (require-state! env)
    (tools/search env {:query query
                       :regex (boolean (:regex args))
                       :caseSensitive (boolean (:caseSensitive args))
                       :limit limit})))

(defn- handle-presence [_args]
  (let [env @env_]
    (require-state! env)
    (tools/presence env)))

(defn- handle-apply-ops [args]
  (let [env @env_
        base-rev (checked-int args :base-rev)
        base-hash (checked-str args :base-hash)
        has-ops? (contains? args :ops)
        has-text? (contains? args :new-section-text)]
    (when (and has-ops? has-text?)
      (throw (ex-info ":ops and :new-section-text are exclusive"
                      {:code :bad-args :reason ":ops and :new-section-text are exclusive"})))
    (when (and (not has-ops?) (not has-text?))
      (throw (ex-info "need :ops or :new-section-text" {:code :bad-args})))
    (let [eff (cond-> {:base-rev base-rev
                       :base-hash base-hash
                       :heading (:heading args)
                       :occurrence (checked-occurrence args)}
                has-ops? (assoc :ops (normalize-op-list (:ops args) :bad-args))
                has-text? (assoc :new-section-text
                                 (let [v (:new-section-text args)]
                                   (when-not (string? v)
                                     (throw (ex-info "new-section-text must be a string"
                                                     {:code :bad-args
                                                      :field :new-section-text
                                                      :got v})))
                                   v))
                (:dryRun args) (assoc :dryRun (boolean (:dryRun args)))
                (some? (:preview args)) (assoc :preview (:preview args))
                (contains? args :verify) (assoc :verify (boolean (:verify args))))]
      (when has-text?
        (checked-str args :heading))
      (require-state! env)
      (connected-check! env)
      (tools/apply-ops env eff))))

(defn- handle-append-to-section [args]
  (let [env @env_
        heading (checked-str args :heading)
        text (let [v (:text args)]
               (when (not (string? v))
                 (throw (ex-info "bad arg text: string required"
                                 {:code :bad-args :field :text :got v})))
               v)
        base-rev (checked-int args :base-rev)
        base-hash (checked-str args :base-hash)
        occurrence (checked-occurrence args)]
    (require-state! env)
    (connected-check! env)
    (tools/append-to-section env {:heading heading :text text
                                  :base-rev base-rev :base-hash base-hash
                                  :occurrence occurrence
                                  :preview (:preview args)
                                  :dryRun (boolean (:dryRun args))
                                  :verify (if (contains? args :verify)
                                             (boolean (:verify args))
                                             true)})))

(defn- handle-set-note [args]
  (let [env @env_
        force (:force args)
        reason (:reason args)
        content (:content args)]
    (when-not (:enable-set-note? (:config env))
      (throw (ex-info "set-note is disabled (set HEDGEDOC_ENABLE_SET_NOTE=true)"
                      {:code :refused :reason :set-note-disabled})))
    (when (not (true? force))
      (throw (ex-info "set-note needs {:force true :reason ...}"
                      {:code :refused :reason "set-note needs {:force true :reason ...}"})))
    (when (or (not (string? reason)) (str/blank? reason))
      (throw (ex-info "set-note needs a non-blank :reason"
                      {:code :bad-args :field :reason})))
    (when (not (string? content))
      (throw (ex-info "set-note needs string :content" {:code :bad-args :field :content})))
    (let [base-rev (checked-int args :base-rev)
          base-hash (checked-str args :base-hash)]
      (require-state! env)
      (connected-check! env)
      (-> (tools/set-note env {:force force :reason reason
                               :base-rev base-rev :base-hash base-hash
                               :content content})
          (.then (fn [res]
                   (log-err (str "audit: set-note " base-rev " -> " (:new-rev res)
                                 " bytes=" (m/utf16-length content)
                                 " reason=" reason))
                   res))))))

(def tool-handlers
  {"get-status" handle-get-status
   "read-section" handle-read-section
   "read-note" handle-read-note
   "apply-ops" handle-apply-ops
   "append-to-section" handle-append-to-section
   "replace-lines" handle-replace-lines
   "insert-lines" handle-insert-lines
   "delete-lines" handle-delete-lines
   "search" handle-search
   "presence" handle-presence
   "set-note" handle-set-note})

;; ---------------- tools/list schemas ----------------

(defn- ok-result [data]
  {:content [{:type "text"
              :text (js/JSON.stringify (clj->js data))}]})

(defn- is-error-result [e]
  {:content [{:type "text"
              :text (js/JSON.stringify (clj->js (errors/err-map e)))}]
   :isError true})

(def ^:private arg-aliases
  "Wire aliases accepted for the canonical camelCase arguments. LLM clients
   strip or rewrite '?', so the wire names must not contain it; old names keep
   working for callers already written against 0.2.0."
  {:dry-run :dryRun
   :dry_run :dryRun
   :dry-run? :dryRun
   :dryRun? :dryRun
   :verify? :verify
   :regex? :regex
   :case-sensitive :caseSensitive
   :case_sensitive :caseSensitive
   :case-sensitive? :caseSensitive
   :caseSensitive? :caseSensitive})

(defn- normalize-args [args]
  (reduce (fn [m [k v]]
            (let [ck (get arg-aliases k k)]
              (when (and (contains? m ck) (not= (get m ck) v))
                (throw (ex-info "conflicting argument aliases"
                                {:code :bad-args :field ck
                                 :values [(get m ck) v]})))
              (assoc m ck v)))
          {} args))

(defn- value-matches-type? [t v]
  (case t
    "integer" (integer? v)
    "number" (number? v)
    "string" (string? v)
    "boolean" (boolean? v)
    true))

(defn- validate-args!
  "Reject unknown arguments and wrong JSON types against the tool schema.
   Typos and stringified booleans should fail loudly, not be coerced."
  [pname args]
  (let [d (first (filter #(= pname (:name %)) schema/tool-defs))
        props (:properties (:inputSchema d))
        allowed (set (keys props))
        extra (vec (remove #(contains? allowed %) (keys args)))]
    (when (seq extra)
      (throw (ex-info (str "unknown argument(s): " (str/join ", " extra))
                      {:code :bad-args
                       :unknown extra
                       :allowed (vec allowed)
                       :hint "remove the unknown keys or check tools/list"})))
    (doseq [[k v] args]
      (let [spec (get props k)
            t (:type spec)
            allowed (:enum spec)]
        (when (and t (not (value-matches-type? t v)))
          (throw (ex-info (str "bad arg " k ": " t " required")
                          {:code :bad-args :field k :expected t :got v
                           :allowed (some->> allowed vec)})))
        (when (and allowed (not (some #(= % v) allowed)))
          (throw (ex-info (str "bad arg " k ": one of "
                               (str/join ", " allowed) " required")
                          {:code :bad-args
                           :field k
                           :got v
                           :allowed (vec allowed)
                           :hint (if (and (= k "sections") (boolean? v))
                                   "use \"none\" instead of a boolean"
                                   (str "allowed: " (str/join ", " allowed)))})))))))

(defn- execute-tool [handler args]
  (-> (js/Promise.resolve nil)
      (.then (fn [] (handler args)))
      (.then (fn [data] (ok-result data)))
      (.catch (fn [e]
                (let [d (ex-data e)]
                  ;; A dry run is a successful preview, not a failure.
                  (if (= :dry-run-preview (:code d))
                    (ok-result (dissoc d :code))
                    (do (when (instance? js/TypeError e)
                          (.error js/console (str "internal: " (errors/err-message e))))
                        (is-error-result e))))))))

;; ---------------- JSON-RPC dispatch ----------------

(defn- initialize-result [params]
  (let [want (:protocolVersion params)]
    {:protocolVersion (if (and (string? want) (not (str/blank? want)))
                        want
                        mcp-protocol-version)
     :capabilities {:tools {:listChanged false}}
     :serverInfo {:name server-name :version server-version}}))

(defn- visible-tool-defs
  "set-note is whole-doc replace: never advertised unless explicitly enabled."
  []
  (if (:enable-set-note? @cfg_)
    schema/tool-defs
    (vec (remove #(= "set-note" (:name %)) schema/tool-defs))))

(defn- handle-call [id params]
  (if (nil? id)
    nil
    (let [pname (:name params)]
      (if (not (string? pname))
        (reply-err id -32602 "Invalid params"
                   {:reason "tools/call needs {name: string, arguments?: object}"})
        (let [h (get tool-handlers pname)]
          (if (nil? h)
            (reply-ok id (is-error-result
                          (ex-info (str "unknown tool: " pname)
                                   {:code :unknown-tool :name pname})))
            (-> (execute-tool (fn [raw] (let [a (normalize-args raw)]
                                          (validate-args! pname a)
                                          (h a)))
                              (or (:arguments params) {}))
                (.then (fn [result] (reply-ok id result)))
                (.catch (fn [e]
                          (reply-ok id (is-error-result e)))))))))))

(defn- dispatch [msg]
  (let [method (:method msg) id (:id msg) params (or (:params msg) {})]
    (cond
      (not (string? method))
      (when (some? id)
        (reply-err id -32600 "Invalid Request" {:reason "missing string method"}))

      (= method "initialize")
      (when (some? id)
        (reply-ok id (initialize-result params)))

      (= method "notifications/initialized")
      nil

      (= method "ping")
      (when (some? id)
        (reply-ok id {}))

      (= method "tools/list")
      (when (some? id)
        (reply-ok id {:tools (visible-tool-defs)}))

      (= method "tools/call")
      (handle-call id params)

      (some? id)
      (reply-err id -32601 "Method not found" {:method method})

      :else nil)))

(defn- handle-line [line]
  (when (not (str/blank? line))
    (try
      (let [msg (decode-line line)]
        (if (map? msg)
          (dispatch msg)
          (reply-err nil -32600 "Invalid Request" {:reason "top-level JSON must be an object"})))
      (catch :default e
        (try
          (reply-err nil -32700 "Parse error" {:message (errors/err-message e)})
          (catch :default _e nil))))))

;; ---------------- stdio loop + shutdown ----------------

(defn- shutdown! [code]
  (when (not @shut_)
    (reset! shut_ true)
    (log-err "hedgedoc-mcp: shutdown")
    (try (t/disconnect!) (catch :default _e nil))
    (try
      (let [rl @rl_]
        (when (some? rl) (.close rl)))
      (catch :default _e nil))
    (js/process.exit code)))

(defn- start-stdio! []
  (let [rl (rl/createInterface #js {:input (.-stdin js/process) :terminal false})]
    (reset! rl_ rl)
    (.on rl "line" (fn [line] (handle-line (str line))))
    (.on rl "close" (fn [] (shutdown! 0)))
    (.on js/process "SIGINT" (fn [] (shutdown! 0)))
    (.on js/process "SIGTERM" (fn [] (shutdown! 0)))
    (.on js/process "uncaughtException"
         (fn [e]
           (log-err (str "hedgedoc-mcp: uncaught " (errors/err-message e)))
           (shutdown! 1)))))

;; ---------------- boot ----------------

(defn- connect-t! []
  (let [cfg @cfg_]
    (-> (t/connect! {:server-url (:origin cfg)
                     :base-path (:base-path cfg)
                     :probe-url (:base-url cfg)
                     :note-id (:note-id cfg)
                     :cookie @cookie_
                     :client-major (:client-major cfg)
                     :transports (:transports cfg)
                     :on-doc on-doc!
                     :on-operation on-operation!
                     :on-ack on-ack!
                     :on-force on-force!
                     :on-info on-info!
                     :on-connect on-connect!
                     :on-connect-error on-connect-error!
                     :on-disconnect (fn [info]
                                      (st/invalidate-rev! state_)
                                      (log-err (str "socket: disconnect "
                                                    (errors/err-message (:reason info))
                                                    "; rev invalidated")))})
        (.then (fn [_s]
                 (log-err "socket: connected")
                 nil))
        (.catch (fn [e]
                  (log-err (str "socket: connect failed: " (errors/err-message e) " "
                                (encode-msg (errors/err-map e))))
                  nil)))))

(defn- boot-download!
  "One /download attempt; schedules another on failure (bounded)."
  [attempt]
  (-> (fetch-download)
      (.then (fn [got]
               (ensure-state! (m/normalize (:content got)))
               (when (some? @state_)
                 (log-err (str "boot: /download ("
                               (m/utf16-length (:content @state_))
                               " UTF-16 units)")))
               nil))
      (.catch (fn [e]
                (log-err (str "boot: /download failed (" (errors/err-message e)
                              "), attempt " (inc attempt)))
                (when (< attempt 20)
                  (-> (sleep-p 3000)
                      (.then (fn [_] (boot-download! (inc attempt))))))
                nil))))

(defn- boot!
  "Idempotent while in flight. Download retries; socket connects regardless
   (its DOC frame can supply state on its own)."
  []
  (when-not @booting_
    (reset! booting_ true)
    (-> (ensure-session!)
        (.then (fn [] (boot-download! 0)))
        (.then (fn [] (connect-t!)))
        (.catch (fn [e]
                  (log-err (str "boot failed: " (errors/err-message e)))
                  nil))
        (.finally (fn [] (reset! booting_ false))))))

(defn- main []
  (try
    (reset! cfg_ (read-config))
    (reset! cookie_ (:cookie @cfg_))
    (reset! env_ (make-env @cfg_))
    (start-stdio!)
    (log-err (str "hedgedoc-mcp " server-version
                  " note=" (:note-id @cfg_)
                  " url=" (:base-url @cfg_)
                  " idle-ms=" (:idle-ms @cfg_)))
    (boot!)
    (catch :default e
      (log-err (encode-msg {:fatal true :error (errors/err-map e)}))
      (js/process.exit 1))))

(main)
