(ns hedgedoc-mcp.transport
  "Socket.IO 2.x/4.x framing. No policy. Effects: connect!/send-op!/disconnect!.
   Wire events arrive via callbacks. selection always nil on emit."
  (:require [clojure.string :as str]
            [hedgedoc-mcp.model :as m]
            ["socket.io-client" :as io]
            ["squint-cljs/src/squint/core.js" :as core]
            [hedgedoc-mcp.state :as st]))

(defonce socket_ (atom nil))
;; Serialized connect: one probe + one socket at a time. A second caller while
;; one is pending joins the same promise; two uncoordinated connects could
;; otherwise clobber socket_ with a stale socket (the replace block runs after
;; the version probe).
(defonce connect-promise_ (atom nil))

(defn server-version
  "GET / and parse hedgedoc-version header. Bounded: a down or half-restarted
   server must not leave connect! pending on a hung fetch."
  [server-url]
  (let [ctrl (js/AbortController.)
        timer (js/setTimeout (fn [] (.abort ctrl)) 4000)]
    (-> (js/fetch (str server-url "/") #js {:signal (.-signal ctrl)})
        (.then (fn [res]
                 (or (.get (.-headers res) "hedgedoc-version")
                     "unknown")))
        (.finally (fn [] (js/clearTimeout timer))))))

(defn assert-compatible!
  "Throws {:code :incompatible-client} unless server-ver and client-major are compatible."
  [server-ver client-major]
  (let [cm (js/parseInt (str client-major) 10)
        v (str server-ver)]
    (cond
      (and (or (str/starts-with? v "1.7") (str/starts-with? v "1.8") (str/starts-with? v "1.9") (str/starts-with? v "1.10"))
           (= cm 2))
      nil
      (and (or (str/starts-with? v "1.11") (str/starts-with? v "1.12")) (= cm 4))
      nil
      :else
      (throw (ex-info (str "incompatible client: server " v " needs socket.io-client " cm ".x")
                      {:code :incompatible-client :server-ver v :client-major cm})))))

(defn- installed-client-major
  "Major of installed socket.io-client, or nil when unversioned."
  []
  (let [v (.-version io)]
    (when (some? v)
      (js/parseInt (first (.split (str v) ".")) 10))))

(defn- open-socket
  [server-url opts-js]
  (let [ctor (or (.-default io) (.-io io) io)]
    (ctor server-url opts-js)))

(defn js->clj-kw [x]
  (cond
    (nil? x) nil
    (js/Array.isArray x) (mapv js->clj-kw x)
    (and (some? x) (= (js/typeof x) "object")) (into {} (map (fn [k] [k (js->clj-kw (aget x k))]) (js/Object.keys x)))
    :else x))

(defn- wire!
  "Attaches server-event handlers. Every effect is the caller's callback."
  [socket {:keys [on-doc on-operation on-ack on-force on-info]}]
  (.onAny socket
          (fn [event & args]
            (cond
              (= event "doc")
              (let [d (js->clj-kw (first args))
                    rev (:revision d)]
                (if (:force d)
                  (when on-force
                    (on-force {:rev rev :content (:str d) :force true :raw d}))
                  (when on-doc
                    (on-doc {:rev rev :content (:str d)
                             :clients (:clients d) :raw d}))))

              (= event "operation")
              (let [client-id (first args)
                    rev (second args)
                    op (nth args 2 nil)
                    sel (nth args 3 nil)]
                (when on-operation
                  (on-operation {:client-id client-id :rev rev
                                 :ops (js->clj-kw op) :selection sel})))

              (= event "operations")
              (let [head (first args)
                    ops (second args)]
                (when on-operation
                  (doseq [[i op] (map-indexed vector (js->clj-kw ops))]
                    (on-operation {:client-id nil :rev (+ head i)
                                   :ops op :selection nil :batch true}))))

              (= event "ack")
              (let [a (first args)
                    r (cond
                        (number? a) a
                        (map? a) (or (:revision a) (:rev a))
                        :else nil)]
                (when (and (some? r) (.isInteger js/Number r))
                  (when on-ack (on-ack {:rev r}))))

              (= event "info")
              (let [d (js->clj-kw (first args))]
                (when on-info (on-info {:code (:code d) :raw d})))

              (= event "refresh")
              nil

              :else nil)))
  socket)

(defn- do-connect!
  "Opens the OT socket for note-id."
  [opts]
  (let [{:keys [server-url probe-url note-id cookie transports base-path
                on-doc on-operation on-ack on-force on-info
                on-connect on-connect-error on-disconnect
                client-major server-ver]} opts
        xports (core/clj__GT_js (or transports ["websocket" "polling"]))
        cm (or client-major (installed-client-major))
        ver-p (if (some? server-ver)
                (.resolve js/Promise server-ver)
                (-> (server-version (or probe-url server-url))
                    (.catch (fn [e]
                              (when on-info
                                (on-info {:code :version-probe-failed
                                          :error (str e)}))
                              nil))))]
    (-> ver-p
        (.then (fn [sv]
                 (when (nil? cm)
                   (throw (ex-info "socket.io-client exposes no version; pass explicit :client-major (2 or 4)"
                                   {:code :bad-args :field :client-major})))
                 ;; A failed probe must not block the socket: the caller named
                 ;; the client major explicitly. Real mismatches still throw.
                 (when (and (some? sv) (not= sv "unknown"))
                   (assert-compatible! sv cm))
                 (when @socket_
                   (let [old @socket_]
                     (.removeAllListeners old)
                     (.disconnect old)
                     (reset! socket_ nil)))
                 (let [opts-js #js {:query #js {:noteId note-id}
                                    :transports xports
                                    ;; Core owns the one reconnect loop
                                    ;; (backoff + generation guard). socket.io
                                    ;; reconnecting on its own would be a second
                                    ;; uncoordinated loop.
                                    :reconnection false
                                    :extraHeaders (if cookie #js {:Cookie cookie} #js {})}
                       _ (when (and (some? base-path) (not (str/blank? (str base-path))))
                           (aset opts-js "path" (str base-path "/socket.io/")))
                       s (open-socket server-url opts-js)]
                   (wire! s {:on-doc on-doc :on-operation on-operation
                             :on-ack on-ack :on-force on-force :on-info on-info})
                   (.on s "connect"
                        (fn [& _rest]
                          (when on-connect
                            (on-connect {}))))
                   (.on s "connect_error"
                        (fn [err & _rest]
                          (when on-connect-error
                            (on-connect-error err))))
                   (.on s "disconnect"
                        (fn [reason & _rest]
                          ;; socket.io keeps emits made while disconnected in
                          ;; sendBuffer and flushes them after re-join. Drop
                          ;; them: their revision belongs to the old socket.
                          (try (aset s "sendBuffer" #js []) (catch :default _e nil))
                          (when on-disconnect
                            (on-disconnect {:reason reason}))))
                   (reset! socket_ s)
                   s))))))

(defn connect!
  "Serialized do-connect!: a second call while one is pending returns the same
   promise and never opens a second socket."
  [opts]
  (or @connect-promise_
      (let [p (-> (do-connect! opts)
                  (.finally (fn [] (reset! connect-promise_ nil))))]
        (reset! connect-promise_ p)
        p)))

(defn send-op!
  "Emits one op and resolves once emitted. Refuses while disconnected: an emit
   on a stale socket is buffered by socket.io and flushed after re-join, where
   its base rev/offsets no longer mean anything. The server verdict arrives as
   a socket event; durability is confirmed by the caller's /download poll."
  [revision ops selection]
  (when (some? selection)
    (throw (ex-info "selection must be nil (-> JSON null)"
                    {:code :selection-not-supported :got selection})))
  (let [s @socket_]
    (when (or (nil? s) (not (.-connected s)))
      (throw (ex-info "not connected" {:code :not-connected})))
    (js/Promise.
     (fn [resolve reject]
       (try
         (.emit s "operation" revision ops nil)
         (resolve {:kind :emitted :rev (inc revision)})
         (catch :default e
           (reject e)))))))

(defn disconnect!
  "Idempotent."
  []
  (when-let [s @socket_]
    (.removeAllListeners s)
    (.disconnect s)
    (reset! socket_ nil))
  nil)

(defn connected?
  "True only for a live transport. (some? @socket_) stayed true during the
   whole disconnect/reconnect window, so callers emitted into socket.io's
   buffer and flushed a stale-base op after re-join."
  []
  (let [s @socket_]
    (and (some? s) (.-connected s))))

(defn get-pending [] nil)
(defn clear-pending! [] nil)