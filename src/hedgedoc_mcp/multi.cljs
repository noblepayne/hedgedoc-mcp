(ns hedgedoc-mcp.multi
  "Multi-note supervisor. One stdio MCP in front, one isolated core process per
   note behind it. A note-id argument on any tool selects the worker; without
   one, HEDGEDOC_NOTE_ID is the default. Isolation is deliberate: each note has
   its own socket, revision state and in-flight write."
  (:require [clojure.string :as str]
            [hedgedoc-mcp.schema :as schema]
            ["node:readline" :as rl]
            ["node:child_process" :as cp]
            ["node:url" :refer [fileURLToPath]]))

(def server-name "hedgedoc-mcp")
(def server-version "0.2.3")
(def mcp-protocol-version "2024-11-05")

(defonce children (atom {}))
(defonce parent-id-counter (atom 1000))

(defn- env-get [k] (aget (.-env js/process) k))
(defn- log-err [s] (.write (.-stderr js/process) (str s "\n")))
(defn- send! [obj] (.write (.-stdout js/process) (str (js/JSON.stringify (clj->js obj)) "\n")))

(defn- core-path
  "Resolve relative to this module, never process.argv[1]. The argv path is a
   symlink when launched through npm's .bin shim (or `npx`), so dirname(argv)
   can point at a directory that has no core.mjs."
  []
  (fileURLToPath (new js/URL "core.mjs" (.-url js/import.meta))))

(defn- default-note [] (env-get "HEDGEDOC_NOTE_ID"))

(defn- note-of
  "note-id from args, else the configured default, else nil."
  [args]
  (or (when (some? args) (aget args "note-id"))
      (default-note)))

(defn- clean-args
  "Drop note-id before forwarding: the worker is already bound to one note."
  [args]
  (if (nil? args)
    #js {}
    (let [copy (js/JSON.parse (js/JSON.stringify args))]
      (aset copy "note-id" js/undefined)
      copy)))

(defn- send-child! [ch obj]
  (.write (aget ch "stdin") (str (js/JSON.stringify (clj->js obj)) "\n")))

(defn- arm-timeout! [ch cid p]
  (js/setTimeout
   (fn []
     (when (get @(aget ch "pending") cid)
       (swap! (aget ch "pending") dissoc cid)
       (send! {:jsonrpc "2.0" :id (aget p "parent")
               :error {:code -32603
                       :message "worker call timed out (180s); worker recycled"}})
       ;; A wedged worker (e.g. catastrophic regex) is replaced on next use.
       (try (.kill (aget ch "proc")) (catch :default _e nil))
       ;; Only remove THIS worker. A late timer from a recycled worker must
       ;; not evict its replacement (that produced two live workers/note).
       (when (identical? (get @children (aget ch "note")) ch)
         (swap! children dissoc (aget ch "note")))))
   180000))

(defn- fail-pending! [ch reason]
  (doseq [[_ p] @(aget ch "pending")]
    (send! {:jsonrpc "2.0" :id (aget p "parent")
            :error {:code -32603 :message (str "worker exited: " reason)}}))
  (reset! (aget ch "pending") {}))

(defn- fail-queue! [ch reason]
  (let [q @(aget ch "queue")]
    (reset! (aget ch "queue") [])
    (doseq [item q]
      (send! {:jsonrpc "2.0" :id (aget item "parent")
              :error {:code -32603 :message (str "worker exited: " reason)}}))))

(defn- flush-queue! [ch]
  (let [q @(aget ch "queue")]
    (reset! (aget ch "queue") [])
    (doseq [item q]
      (let [cid (swap! (aget ch "next-id") inc)]
        (let [pinfo {:parent (aget item "parent")
                     :note (aget ch "note")
                     :name (aget item "name")
                     :args (aget item "args")
                     :attempts (or (aget item "attempts") 0)}]
          (swap! (aget ch "pending") assoc cid
                 (assoc pinfo :timer (arm-timeout! ch cid pinfo))))
        (send-child! ch {:jsonrpc "2.0" :id cid :method "tools/call"
                         :params {:name (aget item "name")
                                  :arguments (aget item "args")}})))))

(defn- handle-child-line! [ch line]
  (when-not (str/blank? line)
    (let [msg (try (js/JSON.parse line) (catch :default _e nil))]
      (when (some? msg)
        (let [id (aget msg "id")]
          (cond
            (and (= id 0) (aget msg "result"))
            (do (reset! (aget ch "ready") true)
                (flush-queue! ch))

            (some? id)
            (let [pending @(aget ch "pending")
                  p (get pending id)]
              (when (some? p)
                (when-let [tm (aget p "timer")] (js/clearTimeout tm))
                (swap! (aget ch "pending") dissoc id)
                (let [result (aget msg "result")
                      txt (try (aget (aget (aget result "content") 0) "text")
                               (catch :default _e nil))
                      booting? (and (some? txt) (str/includes? (str txt) "not-booted"))
                      attempts (or (aget p "attempts") 0)]
                  (cond
                    (and booting? (< attempts 40))
                    (js/setTimeout
                     (fn []
                       (let [cid (swap! (aget ch "next-id") inc)
                             pinfo (assoc p :attempts (inc attempts))]
                         (swap! (aget ch "pending") assoc cid
                                (assoc pinfo :timer (arm-timeout! ch cid pinfo)))
                         (send-child! ch {:jsonrpc "2.0" :id cid :method "tools/call"
                                          :params {:name (aget p "name")
                                                   :arguments (aget p "args")}})))
                     300)

                    (aget msg "error")
                    (send! {:jsonrpc "2.0" :id (aget p "parent")
                            :error (aget msg "error")})

                    :else
                    (send! {:jsonrpc "2.0" :id (aget p "parent")
                            :result result})))))
            :else nil))))))

(defn- spawn-child! [note]
  (let [env (.assign js/Object #js {} (.-env js/process) #js {:HEDGEDOC_NOTE_ID note})
        proc (cp/spawn (.-execPath js/process) #js [(core-path)]
                       #js {:env env :stdio #js ["pipe" "pipe" "pipe"]})
        ch {:note note
            :proc proc
            :stdin (.-stdin proc)
            :next-id (atom 1)
            :pending (atom {})
            :queue (atom [])
            :buf (atom "")
            :ready (atom false)}]
    (.on (.-stdout proc) "data"
         (fn [d]
           (let [combined (str @(aget ch "buf") (str d))
                 parts (str/split combined #"\n" -1)
                 complete (butlast parts)
                 rest (last parts)]
             (reset! (aget ch "buf") (or rest ""))
             (doseq [line complete]
               (handle-child-line! ch line)))))
    (.on (.-stderr proc) "data" (fn [d] (log-err (str "[" note "] " (str d)))))
    ;; A write to a dead child's stdin emits 'error' on the stream; without a
    ;; listener Node throws and the supervisor dies, orphaning every worker.
    (.on (aget ch "stdin") "error"
         (fn [e]
           (log-err (str "worker " note " stdin error: " (str e)))
           (fail-pending! ch "stdin error")
           (fail-queue! ch "stdin error")))
    (.on proc "exit"
         (fn [code _sig]
           ;; Only evict this exact worker, not a replacement spawned after a
           ;; timeout recycled it.
           (when (identical? (get @children note) ch)
             (swap! children dissoc note))
           (log-err (str "worker " note " exited (" code ")"))
           (fail-pending! ch (str "exit " code))
           (fail-queue! ch (str "exit " code))))
    (send-child! ch {:jsonrpc "2.0" :id 0 :method "initialize"
                     :params {:protocolVersion mcp-protocol-version}})
    (log-err (str "worker spawned for note " note))
    ch))

(defn- child-for! [note]
  (or (get @children note)
      (let [ch (spawn-child! note)]
        (swap! children assoc note ch)
        ch)))

(defn- forward-call! [note parent name args]
  (let [ch (child-for! note)
        clean (clean-args args)]
    (if @(aget ch "ready")
      (let [cid (swap! (aget ch "next-id") inc)]
        (let [pinfo {:parent parent :note note :name name :args clean :attempts 0}]
          (swap! (aget ch "pending") assoc cid
                 (assoc pinfo :timer (arm-timeout! ch cid pinfo))))
        (send-child! ch {:jsonrpc "2.0" :id cid :method "tools/call"
                         :params {:name name :arguments clean}}))
      (swap! (aget ch "queue") conj {:parent parent :name name :args clean}))))

;; ---------- parent tool surface ----------

(defn- env-flag? [k]
  (let [v (str/lower-case (str (or (env-get k) "")))]
    (or (= v "1") (= v "true") (= v "yes"))))

(defn- defs-with-note-id []
  (conj
   (->> schema/tool-defs
        (remove (fn [d]
                  (and (= "set-note" (:name d))
                       (not (env-flag? "HEDGEDOC_ENABLE_SET_NOTE")))))
        (mapv (fn [d]
           (let [sch (:inputSchema d)
                 props (assoc (:properties sch) :note-id {:type "string"})]
             (assoc d :inputSchema (assoc sch :properties props))))))
   {:name "list-notes"
    :description "List note ids that currently have a worker (and the default note, if configured)."
    :inputSchema {:type "object" :properties {} :additionalProperties false}}))

(defn- handle-list-notes [id]
  (send! {:jsonrpc "2.0" :id id
          :result {:content [{:type "text"
                              :text (js/JSON.stringify
                                     (clj->js {:default (default-note)
                                               :active (vec (keys @children))}))}]}}))

(defn- reply-error [id msg]
  (send! {:jsonrpc "2.0" :id id :error {:code -32602 :message msg}}))

(defn- handle-call [id params]
  (let [name (aget params "name")
        args (aget params "arguments")]
    (cond
      (not (string? name))
      (reply-error id "tools/call needs a string name")

      (= name "list-notes")
      (handle-list-notes id)

      :else
      (let [note (note-of args)]
        (if (or (nil? note) (not (string? note)) (str/blank? (str note)))
          (send! {:jsonrpc "2.0" :id id
                  :result {:content [{:type "text"
                                      :text (js/JSON.stringify
                                             (clj->js {:code "bad-args"
                                                       :field "note-id"
                                                       :hint "pass note-id or set HEDGEDOC_NOTE_ID"}))}]
                           :isError true}})
          (if-not (re-matches #"[A-Za-z0-9_-]{1,64}" note)
            (reply-error id "note-id must match [A-Za-z0-9_-]{1,64}")
            (let [parsed (js/parseInt (str (or (env-get "HEDGEDOC_MAX_NOTES") "32")) 10)
                  cap (if (js/Number.isNaN parsed) 32 parsed)]
              (if (and (not (contains? @children note)) (>= (count @children) cap))
                (reply-error id (str "worker limit reached (" cap "); set HEDGEDOC_MAX_NOTES"))
                (forward-call! note id name args)))))))))

(defn- handle-line [line]
  (when-not (str/blank? line)
    (let [msg (try (js/JSON.parse line) (catch :default _e nil))]
      (when (some? msg)
        (let [method (aget msg "method")
              id (aget msg "id")
              params (or (aget msg "params") #js {})]
          (cond
            (= method "initialize")
            (when (some? id)
              (send! {:jsonrpc "2.0" :id id
                      :result {:protocolVersion (or (aget params "protocolVersion")
                                                    mcp-protocol-version)
                               :capabilities {:tools {:listChanged false}}
                               :serverInfo {:name server-name :version server-version}}}))

            (= method "notifications/initialized") nil

            (= method "ping")
            (when (some? id) (send! {:jsonrpc "2.0" :id id :result {}}))

            (= method "tools/list")
            (when (some? id)
              (send! {:jsonrpc "2.0" :id id :result {:tools (defs-with-note-id)}}))

            (= method "tools/call")
            (when (some? id) (handle-call id params))

            (some? id)
            (send! {:jsonrpc "2.0" :id id
                    :error {:code -32601 :message (str "Method not found: " method)}})

            :else nil))))))

(defn- main []
  (log-err (str "hedgedoc-mcp multi " server-version
                " default=" (or (default-note) "(none)")
                " core=" (core-path)))
  (let [r (rl/createInterface #js {:input (.-stdin js/process) :crlfDelay js/Infinity})]
    (.on r "line" handle-line)
    (.on r "close"
         (fn []
           (doseq [[_ ch] @children]
             (try (.kill (aget ch "proc")) (catch :default _e nil)))
           (log-err "hedgedoc-mcp multi: shutdown")))))

(main)
