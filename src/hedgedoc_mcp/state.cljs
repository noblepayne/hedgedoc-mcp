(ns hedgedoc-mcp.state
  "Value-atom only. Transitions on ack + remote operation (+ rebuild).
   Clock injected as now-ms arg. No sockets, no js/Date, no selection state."
  (:require [hedgedoc-mcp.model :as m]))

(def velocity-window-ms 60000)

(defn make-initial
  "Boot value. Content normalized; both stamps = boot now-ms (idle 0).
   :rev-stamps starts empty: velocity is 0 until the first rev lands.
   Additive audit keys: :snapshot (nil until first record-snapshot!) and
   :ops-since-snapshot (0). Signatures unchanged."
  [note-id rev content now-ms]
  (assert (string? note-id) "note-id must be a string")
  (assert (integer? rev) "rev must be an integer")
  (assert (integer? now-ms) "now-ms must be injected")
  {:note-id          note-id
   :rev              rev
   :content          (m/normalize content)
   :last-remote-op-at now-ms
   :last-own-op-at    now-ms
   :rev-stamps        []
   :snapshot          nil
   :ops-since-snapshot 0
   ;; Server strings can end with more than one newline; normalization
   ;; collapses them, so ops need a trailing retain of this many units.
   :tail              0})

(defn- prune-stamps [stamps now-ms]
  (filterv #(>= % (- now-ms velocity-window-ms)) stamps))

(defn current [state-atom] @state-atom)

(defn invalidate-rev!
  "Mark the revision unknown without touching content. A revision is only
   valid within the socket generation that learned it; writes must wait for a
   doc frame from the current socket."
  [state-atom]
  (swap! state-atom assoc :rev -1))

(defn set-tail! [state-atom tail]
  (swap! state-atom assoc :tail (max 0 tail)))

(defn tail [state-atom]
  (or (:tail @state-atom) 0))

(defn rev-known? [state-atom]
  (>= (:rev @state-atom) 0))

(defn content-hash
  "H(current normalized content). Recomputed, never cached."
  [value]
  (m/content-hash (:content value)))

(defn snapshot-id
  "H(rev || normalized). Rev alone -> ABA via download lag; hash alone -> rev confusion."
  [value]
  (m/snapshot-id (:rev value) (:content value)))

(defn remote-idle-ms [value now-ms]
  (- now-ms (:last-remote-op-at value)))

(defn rev-velocity
  "Revs/min over trailing 60s window = count of stamps in window."
  [value now-ms]
  (count (prune-stamps (:rev-stamps value) now-ms)))

(defn on-ack!
  "Own op positioned (ack). Caller passes the optimistically-computed
   new-content (already normalized) + server-echoed rev.
   Advances :rev, stamps :last-own-op-at + rev history."
  [state-atom {:keys [rev new-content]} now-ms]
  (assert (integer? rev) "ack rev must be an integer")
  (swap! state-atom
         (fn [v]
           (-> v
               (assoc :rev rev
                      :content (m/normalize new-content)
                      :last-own-op-at now-ms)
               (update :rev-stamps #(conj (prune-stamps % now-ms) now-ms))
               (update :ops-since-snapshot (fn [n] (inc (or n 0))))))))

(defn on-remote-operation!
  "Remote op arrived. Replaces content+rev, stamps :last-remote-op-at."
  [state-atom {:keys [rev new-content]} now-ms]
  (assert (integer? rev) "remote rev must be an integer")
  (swap! state-atom
         (fn [v]
           (-> v
               (assoc :rev rev
                      :content (m/normalize new-content)
                      :last-remote-op-at now-ms)
               (update :rev-stamps #(conj (prune-stamps % now-ms) now-ms))
               (update :ops-since-snapshot (fn [n] (inc (or n 0))))))))

(defn on-rebuild!
  "A full-state doc frame (join, resync, or doc{force:true}). It is a sync, not
   an edit: update rev/content and the remote-idle stamp, but do not count it
   in rev-velocity or the snapshot op counter. Counting the join frame made a
   freshly booted worker report velocity 1 with nobody editing."
  [state-atom {:keys [rev new-content]} now-ms]
  (assert (integer? rev) "rebuild rev must be an integer")
  (swap! state-atom
         (fn [v]
           (-> v
               (assoc :rev rev
                      :content (m/normalize new-content)
                      :last-remote-op-at now-ms)))))

(defn snapshot-for-cas
  "Point-in-time {:rev :hash :snapshot-id :content} for CAS + dry-run use."
  [state-atom]
  (let [v @state-atom]
    {:rev         (:rev v)
     :hash        (content-hash v)
     :snapshot-id (snapshot-id v)
     :content     (:content v)}))

;; --- snapshot audit + op-log GC (audit only; see README) ----------------------
;; Pure fns, clock-injected (now-ms arg), no I/O, no sockets.
;; Value-atom shape is additive only: make-initial seeds
;; :snapshot (nil | {:rev :hash :at}) + :ops-since-snapshot (int);
;; on-ack!/on-remote-operation! bump the counter (bodies only, same arities);
;; record-snapshot! stamps the marker (new fn, same swap! pattern as above).
;; Op-log entries are plain maps carrying at least :rev
;; (e.g. {:rev :hash :at}); prune-op-log only reads :rev.

(defn snapshot-record
  "Audit marker {:rev :hash :at} for the last verified snapshot.
   hash = content-hash of the verified value; now-ms injected."
  [rev hash now-ms]
  (assert (integer? rev) "snapshot rev must be an integer")
  (assert (string? hash) "snapshot hash must be a string")
  (assert (integer? now-ms) "now-ms must be injected")
  {:rev rev :hash hash :at now-ms})

(defn snapshot-valid?
  "Pure re-verify for the repair path. True iff snapshot is non-nil and its
   :rev/:hash match the live value's rev/content-hash.
   False => corrupt-or-stale marker => repair by replace-from-live
   (fresh snapshot-record over the live value on a scratch copy,
   never the live volume), then re-verify."
  [value snapshot]
  (and (not (nil? snapshot))
       (= (:rev snapshot) (:rev value))
       (= (:hash snapshot) (content-hash value))))

(defn is-snapshot-needed?
  "Pure audit gate. threshold = SNAPSHOT_EVERY (op count / version distance).
   Needed when: no snapshot yet (bootstrap); ops since snapshot >= threshold;
   version distance (rev - snapshot-rev) >= threshold; or snapshot age
   (now-ms - at) >= ttl-ms. ttl-ms nil disables the TTL leg."
  [value threshold now-ms ttl-ms]
  (assert (integer? threshold) "threshold must be an integer")
  (assert (> threshold 0) "threshold must be positive")
  (assert (integer? now-ms) "now-ms must be injected")
  (let [snap (:snapshot value)]
    (if (nil? snap)
      true
      (let [ops-since (or (:ops-since-snapshot value) 0)
            dist      (- (:rev value) (:rev snap))]
        (or (>= ops-since threshold)
            (>= dist threshold)
            (and (not (nil? ttl-ms))
                 (not (nil? (:at snap)))
                 (>= (- now-ms (:at snap)) ttl-ms)))))))

(defn can-gc?
  "Pure per-op GC gate. Op at op-rev is collectible iff op-rev <= snapshot-rev
   (never GC ops newer than snapshotVersion -- concurrent inflight survives)
   AND remaining >= min-retain (retain >= minRetain), where remaining is the
   op-log size that would remain if this op were dropped."
  [op-rev snapshot-rev remaining min-retain]
  (assert (integer? op-rev) "op-rev must be an integer")
  (assert (integer? snapshot-rev) "snapshot-rev must be an integer")
  (assert (integer? remaining) "remaining must be an integer")
  (assert (integer? min-retain) "min-retain must be an integer")
  (assert (>= min-retain 0) "min-retain must be non-negative")
  (and (<= op-rev snapshot-rev)
       (>= remaining min-retain)))

(defn prune-op-log
  "Pure. Returns the retained op-log vector (input order preserved):
   the newest min-retain ops are always kept; older ops are kept only when
   their :rev is newer than the snapshot (concurrent inflight).
   nil snapshot => keep everything (nothing is provably superseded)."
  [op-log snapshot min-retain]
  (assert (integer? min-retain) "min-retain must be an integer")
  (assert (>= min-retain 0) "min-retain must be non-negative")
  (if (nil? snapshot)
    (vec op-log)
    (let [v         (vec op-log)
          n         (count v)
          snap-rev  (:rev snapshot)
          keep-from (max 0 (- n min-retain))]
      (loop [i 0 out []]
        (if (>= i n)
          out
          (let [op (nth v i)]
            (recur (inc i)
                   (if (or (>= i keep-from)
                           (> (:rev op) snap-rev))
                     (conj out op)
                     out))))))))

(defn record-snapshot!
  "Stamp the live value's current rev+hash as the audit snapshot and reset
   the ops-since counter. now-ms injected. Additive only: touches :snapshot
   and :ops-since-snapshot, the keys seeded by make-initial."
  [state-atom now-ms]
  (assert (integer? now-ms) "now-ms must be injected")
  (swap! state-atom
         (fn [v]
           (-> v
               (assoc :snapshot (snapshot-record (:rev v) (content-hash v) now-ms))
               (assoc :ops-since-snapshot 0)))))
