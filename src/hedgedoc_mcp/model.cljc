(ns hedgedoc-mcp.model
  "Pure note model: normalize, hash, snapshot-id. No sockets, no clock globals."
  (:require [clojure.string :as str]
            #?(:cljs ["node:crypto" :as node-crypto]))
  #?(:clj (:import (java.security MessageDigest))))

(def ^:private bom "\uFEFF")

(defn strip-bom
  "Remove one leading U+FEFF if present. Interior U+FEFF is preserved."
  [s]
  (assert (string? s) "normalize input must be a string")
  (if (str/starts-with? s bom) (subs s 1) s))

(defn crlf->lf
  "Fold CRLF pairs, then any leftover lone CR (old-Mac), to LF."
  [s]
  (assert (string? s) "normalize input must be a string")
  (-> s
      (str/replace "\r\n" "\n")
      (str/replace "\r" "\n")))

(defn ensure-one-trailing-nl
  "Total function: every input maps to a string ending in exactly one \\n."
  [s]
  (assert (string? s) "normalize input must be a string")
  (str (str/replace s #"\n+$" "") "\n"))

(defn normalize
  "Canonical stored form: BOM-strip -> CRLF->LF -> exactly-one trailing \\n."
  [s]
  (-> s strip-bom crlf->lf ensure-one-trailing-nl))

(defn trailing-nl-valid?
  "Invariant predicate: ends with exactly one \\n."
  [s]
  (and (string? s)
       (str/ends-with? s "\n")
       (not (str/ends-with? s "\n\n"))))

(defn utf16-length
  "Length in UTF-16 code units. Agrees with JS string.length and the OT wire."
  [s]
  (assert (string? s) "utf16-length input must be a string")
  #?(:clj  (.length ^String s)
     :cljs (.-length s)))

#?(:clj
   (defn sha256-hex
     "Lowercase hex SHA-256 over UTF-8 bytes of s (JVM)."
     [s]
     (assert (string? s) "sha256-hex input must be a string")
     (let [md (MessageDigest/getInstance "SHA-256")]
       (.update md (.getBytes ^String s "UTF-8"))
       (apply str (map #(format "%02x" (bit-and % 0xff)) (.digest md)))))
   :cljs
   (defn sha256-hex
     "Lowercase hex SHA-256 over UTF-8 bytes of s (Node/Squint target)."
     [s]
     ;; ESM-safe: crypto comes from the ns :require, never js/require
     ;; (which does not exist in ES module scope).
     (assert (string? s) "sha256-hex input must be a string")
     (-> (node-crypto/createHash "sha256")
         (.update s "utf8")
         (.digest "hex"))))

(defn content-hash
  "H(normalized). sha256-fn defaults to the platform sha256-hex; injectable."
  ([normalized] (content-hash sha256-hex normalized))
  ([sha256-fn normalized]
   (assert (trailing-nl-valid? normalized) "hash only normalized content")
   (sha256-fn normalized)))

(defn snapshot-preimage
  "Canonical preimage bytes-as-string: \"<rev>:<normalized>\"."
  [rev normalized]
  (assert (integer? rev) "rev must be an integer")
  (assert (trailing-nl-valid? normalized) "snapshot only normalized content")
  (str rev ":" normalized))

(defn snapshot-id
  "H(rev || normalizedContent) with ':' separator against concat ambiguity."
  ([rev normalized] (snapshot-id sha256-hex rev normalized))
  ([sha256-fn rev normalized]
   (sha256-fn (snapshot-preimage rev normalized))))

(defn make-snapshot
  "Stored-value constructor. now-ms is passed in (clock as arg, never global)."
  ([note-id rev content now-ms]
   (make-snapshot sha256-hex note-id rev content now-ms))
  ([sha256-fn note-id rev content now-ms]
   (let [n (normalize content)]
     {:note-id  note-id
      :rev      rev
      :content  n
      :hash     (sha256-fn n)
      :snapshot-id (sha256-fn (snapshot-preimage rev n))
      :at       now-ms})))
