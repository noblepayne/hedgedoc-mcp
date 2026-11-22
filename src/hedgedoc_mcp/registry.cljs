(ns hedgedoc-mcp.registry
  "Worker heartbeat registry, shared by core (writer) and multi (reader).

   No module-level side effects: every function does its own IO and nothing
   runs at load time, so both processes can import the compiled module.

   Path: $XDG_RUNTIME_DIR/hedgedoc-mcp/<note>-<pid>.json, falling back to
   /tmp/opencode/hedgedoc-mcp when XDG_RUNTIME_DIR is absent. Writes are
   temp-file + rename so a reader never sees half a JSON object.

   Liveness rules (from the 2026-11-21 incident review, section E):
   - /proc/<pid>/cmdline is read first; the PID counts as one of ours only when
     the cmdline contains hedgedoc_mcp or core.mjs. A reused PID therefore
     reads as dead even though the number is alive.
   - kill(pid, 0) is the fallback ONLY when /proc is unavailable. Signal 0
     tests existence; it never signals the process.
   - A heartbeat older than 90s is marked :stale, not deleted. Files are pruned
     only when the PID is gone. Nothing here ever kills or signals a process."
  (:require [clojure.string :as str]
            ["node:fs" :as fs]))

(def stale-ms
  "A heartbeat older than this is stale. Readers fall back to a live query."
  90000)

(defn- env-get [k]
  (aget (.-env js/process) k))

(defn registry-dir
  "Runtime directory for heartbeat files. Read per call, never cached: tests
   point XDG_RUNTIME_DIR at a scratch dir."
  []
  (let [xdg (env-get "XDG_RUNTIME_DIR")]
    (if (and (some? xdg) (not (str/blank? (str xdg))))
      (str xdg "/hedgedoc-mcp")
      "/tmp/opencode/hedgedoc-mcp")))

(defn entry-path [note pid]
  (str (registry-dir) "/" (str note) "-" (str pid) ".json"))

;; ---------------- liveness ----------------

(defn cmdline-live?
  "Pure predicate over a NUL-joined /proc/<pid>/cmdline string. The compiled
   entrypoints are hedgedoc_mcp/{core,multi}.mjs, in a working tree or a Nix
   store path; both contain one of the needles."
  [s]
  (let [t (str s)]
    (or (str/includes? t "hedgedoc_mcp")
        (str/includes? t "core.mjs"))))

(defn procfs-available? []
  (try (.existsSync fs "/proc/self/cmdline") (catch :default _e false)))

(defn- kill0-live?
  "Existence probe only. EPERM means another user owns the PID: alive."
  [pid]
  (try
    (.kill js/process pid 0)
    true
    (catch :default e
      (= "EPERM" (str (.-code e))))))

(defn pid-live?
  "True only for a live process whose cmdline looks like one of ours. Falls
   back to kill(pid, 0) when /proc is unavailable."
  [pid]
  (if (not (number? pid))
    false
    (if (procfs-available?)
      (try
        (cmdline-live? (.readFileSync fs (str "/proc/" pid "/cmdline") "utf8"))
        (catch :default _e false))
      (kill0-live? pid))))

;; ---------------- write / remove ----------------

(defn- ensure-dir! []
  (let [d (registry-dir)]
    (.mkdirSync fs d #js {:recursive true})
    d))

(defn write-entry!
  "Write one heartbeat atomically. Takes a plain map (string or keyword keys);
   JSON.stringify drops nil values, so absent fields stay absent."
  [entry]
  (let [d (ensure-dir!)]
    (when (and (some? (:note entry)) (some? (:pid entry)))
      (let [p (entry-path (:note entry) (:pid entry))
            tmp (str p ".tmp")]
        (.writeFileSync fs tmp (js/JSON.stringify (clj->js entry)))
        (.renameSync fs tmp p)
        p))))

(defn remove-entry!
  "Owner-exit cleanup. Missing file is not an error."
  [note pid]
  (when (and (some? note) (some? pid))
    (try
      (.unlinkSync fs (entry-path note pid))
      true
      (catch :default _e false))))

;; ---------------- read ----------------

(defn- read-json-file [p]
  (try (js/JSON.parse (.readFileSync fs p "utf8"))
       (catch :default _e nil)))

(defn entry-stale?
  ([e] (entry-stale? e (.now js/Date)))
  ([e now]
   (let [hb (:lastHeartbeat e)]
     (or (not (number? hb)) (> (- now hb) stale-ms)))))

(defn read-entry [note pid]
  (read-json-file (entry-path note pid)))

(defn read-entries
  "All registry entries as JSON objects. Dead-PID files are pruned (that is
   the only deletion rule); every surviving entry gets :stale and :live
   fields. Unparsable or still-being-written files are skipped, not deleted."
  []
  (let [d (registry-dir)
        now-ms (fn [] (.now js/Date))]
    (if-not (.existsSync fs d)
      []
      (let [files (try (.readdirSync fs d) (catch :default _e []))
            out (atom [])]
        (doseq [f files]
          (when (str/ends-with? (str f) ".json")
            (let [p (str d "/" f)
                  e (read-json-file p)]
              (when (some? e)
                (let [pid (:pid e)
                      live? (pid-live? pid)]
                  (if live?
                    (do (aset e "stale" (entry-stale? e (now-ms)))
                        (aset e "live" true)
                        (swap! out conj e))
                    ;; The only deletion rule: the PID is gone. A stale
                    ;; heartbeat on a live PID is kept and marked.
                    (try (.unlinkSync fs p) (catch :default _e nil))))))))
        (vec @out)))))

;; ---------------- reader views ----------------

(defn entry-summary
  "The pinned, sanitized view of one entry. Never leak arbitrary JSON."
  [e]
  {:note (:note e)
   :pid (:pid e)
   :version (:version e)
   :connected (boolean (:connected e))
   :writable (boolean (:writable e))
   :rev (:rev e)
   :attempts (:attempts e)
   :lastConnectAt (:lastConnectAt e)
   :lastDisconnectAt (:lastDisconnectAt e)
   :lastHeartbeat (:lastHeartbeat e)
   :stale (boolean (:stale e))
   :live (if (nil? (:live e)) true (boolean (:live e)))})

(defn worker-summary
  "list-notes.workers shape. Pinned by the work order: :note :pid :version
   :connected :writable :lastConnectAt :attempts."
  [e]
  {:note (:note e)
   :pid (:pid e)
   :version (:version e)
   :connected (boolean (:connected e))
   :writable (boolean (:writable e))
   :lastConnectAt (:lastConnectAt e)
   :attempts (:attempts e)})

(defn entries-for-pids
  "Entries whose pid is in pids (a vector of numbers). Filters stale files
   from other supervisors and from dead processes."
  [entries pids]
  (filterv (fn [e] (some #(= % (:pid e)) pids)) entries))

(defn duplicates
  "Note ids served by more than one live PID. [{:note :pids}]"
  [entries]
  (let [acc (reduce (fn [m e]
                      (let [n (str (:note e))
                            ps (or (get m n) [])]
                        (assoc m n (conj ps (:pid e)))))
                    {} entries)]
    (->> (js/Object.entries acc)
         (filter (fn [pair] (> (count (aget pair 1)) 1)))
         (mapv (fn [pair] {:note (aget pair 0) :pids (vec (aget pair 1))})))))

(defn version-mismatch
  "Live entries whose version differs from `current`. Covers the old
   working-tree process alive next to the Nix one."
  [entries current]
  (let [bad (filterv (fn [e] (not= current (:version e))) entries)]
    {:current current
     :mismatch (pos? (count bad))
     :entries (mapv (fn [e] {:note (:note e)
                             :pid (:pid e)
                             :version (:version e)
                             :script (:script e)}) bad)
     :hint (when (pos? (count bad))
             "two versions are serving notes; stop the extra PID yourself, doctor never kills")}))

(defn doctor-report
  "Pure assembly of the doctor payload. The caller supplies the IO results:
   {:server ... :workers [...] :entries [...] :version ...}. Read-only by
   construction: nothing here mutates a process or a file."
  [base]
  (let [server (get base :server)
        workers (get base :workers [])
        entries (get base :entries [])
        version (get base :version)
        dup (duplicates entries)
        vm (version-mismatch entries version)
        timeouts (filterv (fn [w] (= "timeout" (:status w))) workers)]
    {:server server
     :workers workers
     :registry (mapv entry-summary entries)
     :duplicates dup
     :versionMismatch vm
     :timeouts (mapv (fn [w] {:note (:note w) :pid (:pid w)}) timeouts)
     :pid (.-pid js/process)
     :readOnly true
     :hint (cond
             (pos? (count dup))
             "duplicate workers are listed above with PIDs; stop the extra process yourself, doctor never kills"

             (:mismatch vm)
             "mixed versions are listed above with PIDs; stop the extra process yourself, doctor never kills"

             (pos? (count timeouts))
             "a worker did not answer within 5s; it is wedged or still booting, doctor leaves it alone"

             :else
             "single worker per note, version matched")}))
