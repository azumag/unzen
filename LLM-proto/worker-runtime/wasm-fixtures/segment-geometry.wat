;; Review source for segment-geometry.wasm (issue #306).
;;
;; ABI:
;;   check(index, expectedIndex, layerStart, expectedLayerStart,
;;         layerEnd, totalLayers, isLast) -> reasonCode
;;
;; Reason codes:
;;   0 valid
;;   1 segment index is not the expected 0..N-1 value
;;   2 layerStart is not the expected contiguous start
;;   3 layerEnd < layerStart
;;   4 layerEnd >= totalLayers
;;   5 final segment does not end at totalLayers - 1
;;
;; All arguments are preflighted in JavaScript as non-negative safe integers
;; <= i32::MAX before this function is called. The module therefore keeps only
;; the deterministic integer geometry core; JSON/object parsing and numeric
;; domain rejection remain JavaScript responsibilities.
(module
  (func (export "check")
    (param $index i32)
    (param $expectedIndex i32)
    (param $layerStart i32)
    (param $expectedLayerStart i32)
    (param $layerEnd i32)
    (param $totalLayers i32)
    (param $isLast i32)
    (result i32)
    (if (result i32)
      (i32.ne (local.get $index) (local.get $expectedIndex))
      (then (i32.const 1))
      (else
        (if (result i32)
          (i32.ne (local.get $layerStart) (local.get $expectedLayerStart))
          (then (i32.const 2))
          (else
            (if (result i32)
              (i32.lt_s (local.get $layerEnd) (local.get $layerStart))
              (then (i32.const 3))
              (else
                (if (result i32)
                  (i32.ge_s (local.get $layerEnd) (local.get $totalLayers))
                  (then (i32.const 4))
                  (else
                    (if (result i32)
                      (i32.and
                        (i32.ne (local.get $isLast) (i32.const 0))
                        (i32.ne
                          (local.get $layerEnd)
                          (i32.sub (local.get $totalLayers) (i32.const 1))))
                      (then (i32.const 5))
                      (else (i32.const 0))))))))))))))
