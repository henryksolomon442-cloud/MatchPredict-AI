// MATCHES PRO — confirmation only. Does not generate or alter predictions.
(function (root) {
  "use strict";
  const MATCH_CIRCLE_CONFIRM = {
    0: { below10: [1,2,3], watch: [1,2], entry: 2, minBelow: 3 },
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
    const target = Number.parseInt(String(oldPrediction).split(/\s+/)[1], 10);
    if (!Number.isInteger(target) || target < 0 || target > 9) {
      return { confirmed:false, score:0, reason:"Invalid Matches digit" };
    }
    if (!Array.isArray(digits) || digits.length < 100 ||
        digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)) {
      return { confirmed:false, score:0, target, reason:"Need 100 valid ticks before confirmation" };
    }

    const last100 = digits.slice(-100);
    const last20 = digits.slice(-20);
    const current = last100[last100.length - 1];
    const cfg = MATCH_CIRCLE_CONFIRM[target];
    const pctTarget = pct(last100, target);
    const check1 = pctTarget >= 11;

    let belowCount = 0;
    cfg.below10.forEach(d => { if (pct(last100, d) < 10) belowCount++; });
    const needBelow = cfg.minBelow || cfg.below10.length;
    const check2 = belowCount >= needBelow;

    const pctTarget20 = pct(last20, target);
    const check3 = Math.abs(pctTarget20 - pctTarget) < 1.0;

    let check4 = true;
    cfg.watch.forEach(d => {
      if (Math.abs(pct(last20, d) - pct(last100, d)) > 1.5) check4 = false;
    });
    // Entry timing: accept the configured entry digit if it appeared in the latest 3 ticks.
    const last3 = digits.slice(-3);
    const check5 = last3.includes(cfg.entry);
    const checks = { check1, check2, check3, check4, check5 };
    const score = Object.values(checks).filter(Boolean).length;

    // Strength is mandatory; any two of the remaining four checks must also pass.
    const confirmed = check1 && score >= 3;

    return {
      confirmed, score, target, entry:cfg.entry, current,
      pctTarget:pctTarget.toFixed(1), belowCount, needBelow,
      checks,
      reason: confirmed
        ? `CONFIRMED Matches ${target} | ${pctTarget.toFixed(1)}% | Below10 ${belowCount}/${cfg.below10.length} | Neutral OK | Watch Stable | Entry ${current}==${cfg.entry}`
        : `NOT CONFIRMED Matches ${target} | ${score}/5 checks | Strength:${check1?"PASS":"FAIL"} Below10:${check2?"PASS":"FAIL"} Neutral:${check3?"PASS":"FAIL"} Stable:${check4?"PASS":"FAIL"} Entry:${check5?"PASS":"FAIL"} (need ${cfg.entry}, current ${current})`
    };
  }

  root.MATCHES_PRO_CONFIRM = Object.freeze({ confirmMatches });
})(window);
