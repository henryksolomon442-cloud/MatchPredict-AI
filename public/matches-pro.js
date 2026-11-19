// MATCHES PRO V3 — confirmation only. Does not generate or alter predictions.
(function (root) {
  "use strict";
  const MATCH_CIRCLE_CONFIRM = {
    0: { below10: [1,2,3], watch: [1,2], entry: 2 },
    1: { below10: [0,2,3], watch: [2,3], entry: 3 },
    2: { below10: [0,1,3,4], watch: [1,3,4], entry: 4 },
    3: { below10: [0,1,2,4], watch: [2,4], entry: 2 },
    4: { below10: [0,1,2,3], watch: [2,3], entry: 4 },
    5: { below10: [0,1,2,3,4], watch: [3,4], entry: 2 },
    6: { below10: [0,1,2,3,5], watch: [5,4], entry: 2 },
    7: { below10: [0,1,2,3,4,5], watch: [5,6], entry: 4 },
    8: { below10: [0,1,2,3,4,6], watch: [7,6], entry: 2 },
    9: { below10: [0,1,2,3,4,5,6], watch: [6,7,8], entry: 4 }
  };

  function pct(digits, digit) {
    if (!digits.length) return 0;
    return digits.filter(x => x === digit).length / digits.length * 100;
  }

  function confirmMatches(oldPrediction, digits) {
    if (!oldPrediction || !String(oldPrediction).startsWith("Matches")) {
      return { confirmed:false, score:0, reason:"Not a Matches prediction" };
    }

    const target = Number.parseInt(String(oldPrediction).split(/\\s+/)[1], 10);
    if (!Number.isInteger(target) || target < 0 || target > 9) {
      return { confirmed:false, score:0, reason:"Invalid Matches digit" };
    }

    if (!Array.isArray(digits) || digits.length < 100 ||
        digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
      return { confirmed:false, score:0, target, reason:"Need at least 100 valid ticks before confirmation" };
    }

    // V3 windows: up to 300 for the main sample, 50 recent, and 10 for entry timing.
    const last300 = digits.slice(-300);
    const last50 = digits.slice(-50);
    const last10 = digits.slice(-10);
    const current = last300[last300.length - 1];
    const cfg = MATCH_CIRCLE_CONFIRM[target];

    const pctTarget = pct(last300, target);

    // Check 1 — target strength is mandatory.
    const check1 = pctTarget >= 11;

    // Check 2 — at least two configured comparison digits must be <= 11%.
    let belowCount = 0;
    cfg.below10.forEach(d => {
      if (pct(last300, d) <= 11) belowCount++;
    });
    const needBelow = 2;
    const check2 = belowCount >= needBelow;

    // Check 3 — recent target frequency must stay close to the main window.
    const pctTarget50 = pct(last50, target);
    const neutralDiff = Math.abs(pctTarget50 - pctTarget);
    const check3 = neutralDiff <= 2.0;

    // Check 4 — watched digits must also remain stable across the two windows.
    let stableMaxDiff = 0;
    cfg.watch.forEach(d => {
      const diff = Math.abs(pct(last50, d) - pct(last300, d));
      stableMaxDiff = Math.max(stableMaxDiff, diff);
    });
    const check4 = stableMaxDiff <= 2.0;

    // Check 5 — configured entry digit appeared within the latest 10 ticks.
    const check5 = last10.includes(cfg.entry);

    const checks = { check1, check2, check3, check4, check5 };
    const score = Object.values(checks).filter(Boolean).length;

    // V3 gate: Strength + Below10 are mandatory, plus at least one other check.
    const confirmed = check1 && check2 && score >= 3;

    return {
      confirmed,
      score,
      target,
      entry: cfg.entry,
      current,
      pctTarget: pctTarget.toFixed(1),
      pctTarget50: pctTarget50.toFixed(1),
      belowCount,
      needBelow,
      windowSizes: { main: last300.length, recent: last50.length, entry: last10.length },
      differences: {
        neutral: Number(neutralDiff.toFixed(2)),
        stableMax: Number(stableMaxDiff.toFixed(2))
      },
      checks,
      reason: confirmed
        ? `CONFIRMED Matches ${target} | ${pctTarget.toFixed(1)}% main | ${score}/5 checks | windows ${last300.length}/${last50.length}/${last10.length}`
        : `NOT CONFIRMED Matches ${target} (${pctTarget.toFixed(1)}%) | ${score}/5 checks | Strength:${check1?"PASS":"FAIL"} Below10:${check2?"PASS":"FAIL"} Neutral:${check3?"PASS":"FAIL"} Stable:${check4?"PASS":"FAIL"} EntryNear(10):${check5?"PASS":"FAIL"} | Need Strength + Below10 + 1 more; entry digit ${cfg.entry}; windows ${last300.length}/${last50.length}/${last10.length}`
    };
  }

  root.MATCHES_PRO_CONFIRM = Object.freeze({ confirmMatches });
})(window);
