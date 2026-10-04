/*
 * view.js: a /review body -> what the sidebar shows (pure; no Apps Script globals).
 *
 * build(body, opts) -> Model. Every string the sidebar shows comes from here or
 * from LenzApi.describeError; the sidebar renders each one as a text node.
 *
 * Groups, in this order, each in the Doc's order (a reader walks the Doc):
 *   issue  claims with an issue (result.is_issue) and citation issues
 *   look   "Needs a closer look": partly supported citations, citations whose
 *          check could not decide, claims drawn amber (low confidence)
 *   none   "Not checked": citations with no text, failed checks, failed claims
 *   ok     "Checks out", collapsed behind its count
 * The group of a row is the state Lenz's Workbench gives it, except that an
 * issue is an issue whatever its colour. Words: the ones Lenz uses for findings
 * elsewhere (editor register).
 *
 * Ids: `claim:<index>` / `citation:<index>` (the body's own indexes, stable
 * across polls), and `<claimIndex>:<editIndex>` for an edit. The sidebar sends
 * only these back; row() finds the row again in a fresh read of the review on
 * the server, and LenzPlace's builders make the target.
 */
var LenzView = (function () {
  'use strict';

  // lenz-check-states.js STATES.
  var STATE_WORDS = {
    bad: "Doesn't check out",
    look: 'Needs a closer look',
    ok: 'Checks out',
    none: 'Not checked',
  };

  // `pending`: a row still being checked while the review runs (never a failure).
  var GROUPS = ['issue', 'look', 'pending', 'none', 'ok'];
  var GROUP_TITLES = {
    issue: 'Issues',
    look: 'Needs a closer look',
    pending: 'Checking',
    none: 'Not checked',
    ok: 'Checks out',
  };

  // Lenz's finding words and verdict colour token, per finding.
  var FINDINGS = {
    doi_not_found: ['DOI not registered', 'false'],
    page_not_found: ['Page not found', 'false'],
    contradicted: ['Contradicted', 'false'],
    quote_not_in_source: ['Quote not in the source', 'false'],
    not_in_source: ['Not in the source', 'mostly-false'],
    metadata_mismatch: ['Reference details differ', 'mostly-false'],
    partly_supported: ['Needs a closer look', 'mostly-true'],
    supported: ['Supported', 'true'],
    unchecked: ['Not checked', null],
  };
  // lenz-check-states.js CITATION.
  var CITATION_STATE = {
    doi_not_found: 'bad',
    page_not_found: 'bad',
    contradicted: 'bad',
    quote_not_in_source: 'bad',
    not_in_source: 'bad',
    metadata_mismatch: 'bad',
    partly_supported: 'look',
    supported: 'ok',
    unchecked: 'none',
  };
  var LOOK_REASONS = { inconclusive: true, unclear_pairing: true };

  // ui_words.py REASONS; the row's own `check.hint` comes first.
  var REASONS = {
    no_text: 'The page gave no text to read.',
    partial_text: 'Only part of the page could be read, so a missing passage proves nothing.',
    login_required: 'The page needs a login.',
    unsupported_site: 'Lenz does not read this site.',
    no_statement: 'No sentence in the draft rests on this source.',
    other_version: 'Only a preprint could be read, and its wording may differ from the published paper.',
    inconclusive: "Lenz couldn't determine whether this source supports the statement.",
    unclear_pairing: "Lenz couldn't tell which claim this citation is given for.",
    ambiguous_reference: 'The DOI could not be read off the reference with certainty.',
    invalid_url: 'This is not a public web address.',
  };
  var FALLBACK_REASON = 'This source could not be checked.';

  var VERDICT_TOKENS = {
    True: 'true',
    'Mostly True': 'mostly-true',
    Mixed: 'mixed',
    'Mostly False': 'mostly-false',
    False: 'false',
  };

  var SKIPPED = {
    switched_off: 'Citations were not checked this time: the citation check is switched off.',
    url_input: 'Citations were not checked.',
    insufficient_credits: 'Citations were not checked: not enough credits.',
  };

  var NOT_READ = [
    ['footnotes', 'footnote', 'footnotes'],
    ['headers', 'header', 'headers'],
    ['footers', 'footer', 'footers'],
    ['images', 'image', 'images'],
    ['equations', 'equation', 'equations'],
    ['otherChips', 'smart chip', 'smart chips'],
    ['otherTabs', 'other tab', 'other tabs'],
  ];

  var PROGRESS = {
    queued: 'Waiting to start',
    assessing: 'Checking the claims',
    verifying: 'Running deep checks',
  };

  function isObj(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }
  function arr(x) {
    return Array.isArray(x) ? x : [];
  }
  function str(x) {
    return typeof x === 'string' && x.length ? x : null;
  }
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // lenz-check-states.js forClaim.
  function claimState(verdict, confidence) {
    if (!verdict || verdict === 'Error') return 'none';
    if (confidence === 'low') return 'look';
    if (verdict === 'True' || verdict === 'Mostly True') return 'ok';
    if (verdict === 'Mostly False' && confidence === 'medium') return 'look';
    if (verdict === 'False' || verdict === 'Mostly False') return 'bad';
    if (verdict === 'Mixed') return 'look';
    return 'none';
  }

  function citationState(row) {
    var result = row && row.result;
    if (!isObj(result) || !result.finding) return 'none';
    var state = CITATION_STATE[result.finding] || 'none';
    if (state === 'none' && LOOK_REASONS[(isObj(row.check) && row.check.unchecked_reason) || '']) return 'look';
    return state;
  }

  // A link the sidebar may open: Lenz's own claim pages only.
  function lenzPage(url) {
    return typeof url === 'string' && url.indexOf('https://lenz.io/c/') === 0 ? url : null;
  }

  // A third-party source: http(s) only, shown by its host.
  function sourceLink(url) {
    if (typeof url !== 'string') return null;
    var m = /^https?:\/\/([^\/?#:@]+)/i.exec(url);
    if (!m) return null;
    return { href: url, words: m[1].replace(/^www\./i, '') };
  }

  function firstStart(positions) {
    var p = arr(positions)[0];
    return isObj(p) && typeof p.start === 'number' ? p.start : null;
  }

  // An edit is known by its content, never by its place in a list: a claim's block is replaced
  // (quick edits first, then the deep check's: new edits, other indexes) without saying which is
  // which. fp = span + a hash of its words and replacement; the sidebar sends it back with a click,
  // so the server applies only the edit the user saw (it is compared, never written as text).
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function editFp(start, end, text, replacement) {
    return start + ':' + end + ':' + hash(String(text) + '\u0000' + String(replacement));
  }

  function recordFp(rec) {
    return rec && rec.orig ? editFp(rec.orig.start, rec.orig.end, rec.origText, rec.replacement) : null;
  }

  // An older add-on's record (no `orig`): known by its id "claim:edit" in the block it saw.
  function legacyIndex(rec) {
    var m = /^(\d+):(\d+)$/.exec(String(rec.id));
    return m ? { claimIndex: Number(m[1]), editIndex: Number(m[2]) } : null;
  }

  // Overlap in the original text's offsets (an empty span touching counts).
  function overlaps(rec, e) {
    if (!rec.orig || typeof e.start !== 'number' || typeof e.end !== 'number') return false;
    var a0 = rec.orig.start, a1 = rec.orig.end;
    if (e.start === e.end || a0 === a1) return e.start <= a1 && a0 <= e.end;
    return e.start < a1 && a0 < e.end;
  }

  /**
   * A claim's edits as the sidebar shows them, each with a mode: `apply` (its words are as
   * checked), `applied` (the same change is in the Doc: Undo), `suggest` (an applied edit changed its
   * words: shown, no Apply; Undo that one first). An applied edit the block no longer lists stays,
   * `earlier`, with its Undo. Undo names the record: { claimIndex, editIndex, fp } (fp null for an
   * older add-on's record, found by its index).
   */
  function editsOf(row, opts) {
    var ci = row.index;
    var block = isObj(row.suggested_edits) ? row.suggested_edits : null;
    var all = arr(opts.appliedEdits).filter(isObj);
    var records = all.filter(function (r) {
      if (r.orig) return r.claimIndex === ci;
      var li = legacyIndex(r);
      return !!li && li.claimIndex === ci;
    });
    var legacy = isObj(opts.applied) ? opts.applied : {};
    var list = block && block.status === 'completed' ? arr(block.edits) : [];
    var out = [];
    var used = {};
    list.forEach(function (e, j) {
      if (!isObj(e) || typeof e.text !== 'string' || typeof e.replacement !== 'string') return;
      var fp = editFp(e.start, e.end, e.text, e.replacement);
      var match = null;
      records.forEach(function (r) {
        if (match || used[r.id]) return;
        if (r.orig ? recordFp(r) === fp : (legacyIndex(r).editIndex === j)) match = r;
      });
      var mode = 'apply';
      if (match || legacy[ci + ':' + j]) mode = 'applied';
      else if (all.some(function (r) { return overlaps(r, e); })) mode = 'suggest';
      if (match) used[match.id] = true;
      out.push({
        id: ci + ':' + fp, claimIndex: ci, editIndex: j, fp: fp, from: e.text, to: e.replacement,
        mode: mode, applied: mode === 'applied',
        undo: mode === 'applied' ? { claimIndex: ci, editIndex: j, fp: match ? recordFp(match) : null } : null,
      });
    });
    // Applied edits this block does not list (it was replaced, or the edit withdrawn): still undoable.
    records.forEach(function (r) {
      if (used[r.id] || !r.orig) return;
      out.push({
        id: ci + ':' + recordFp(r), claimIndex: ci, editIndex: -1, fp: recordFp(r), from: r.origText, to: r.replacement,
        mode: 'applied', applied: true, earlier: true, undo: { claimIndex: ci, editIndex: -1, fp: recordFp(r) },
      });
    });
    return { edits: out, note: null };
  }



  var DEEP_FAILURE_TEXT = {
    insufficient_evidence: 'The deep check found too few public sources to give a verdict, so this is the quick verdict.',
    upstream_unavailable: 'The deep check could not run because search was unavailable, so this is the quick verdict.',
  };

  // Why a row's deep check failed, by the failure's class; a failure without one keeps the plain line.
  function deepFailureClass(verification) {
    var f = isObj(verification) && isObj(verification.failure) ? verification.failure : {};
    return str(f.failure_class);
  }

  function deepFailureText(verification) {
    return DEEP_FAILURE_TEXT[deepFailureClass(verification)] || 'The deep check did not finish, so this is the quick verdict.';
  }

  // The failed deep checks no rerun can change: too few public sources, and not marked retryable.
  function tooFewSources(verification) {
    var f = isObj(verification) && isObj(verification.failure) ? verification.failure : {};
    return isObj(verification) && verification.status === 'failed' && f.failure_class === 'insufficient_evidence' && f.retryable !== true;
  }

  function countTooFewSources(body) {
    var n = 0;
    if (Array.isArray(body.claims)) {
      body.claims.forEach(function (r) {
        if (isObj(r) && tooFewSources(r.verification)) n++;
      });
    }
    return n;
  }

  // Whether choosing Check this Doc again can help an incomplete review: false only when every check
  // that did not finish is a deep check that found too few sources. Anything unknown counts as retryable.
  function retryHelps(body) {
    body = isObj(body) ? body : {};
    if (body.outcome !== 'incomplete') return false;
    var s = isObj(body.summary) ? body.summary : {};
    var a = isObj(s.assessments) ? s.assessments : {};
    var v = isObj(s.verifications) ? s.verifications : {};
    var c = isObj(s.citation_checks) ? s.citation_checks : {};
    var thin = countTooFewSources(body);
    return !(thin > 0 && thin >= (v.failed || 0) && !(a.failed > 0) && !(c.failed > 0));
  }

  function claimEntry(row, opts) {
    var result = isObj(row.result) ? row.result : {};
    var assessment = isObj(row.assessment) ? row.assessment : {};
    var verification = isObj(row.verification) ? row.verification : null;
    var deep = result.source === 'verification' && verification !== null && verification.status === 'completed';
    var verdict = str(result.verdict);
    var confidence = str(result.confidence);
    var state = claimState(verdict, confidence);
    var group = result.is_issue === true ? 'issue' : state;
    // No verdict yet while the review runs and the quick check has not failed: still being checked.
    var checking = !verdict && !opts.done && assessment.status !== 'failed';
    if (checking) group = 'pending';
    var lines = [];
    var e = {
      id: 'claim:' + row.index,
      kind: 'claim',
      group: group,
      state: state,
      stateWords: STATE_WORDS[state],
      title: str(row.claim) || '',
      label: verdict && verdict !== 'Error' ? verdict : checking ? 'Checking' : 'Not checked',
      token: VERDICT_TOKENS[verdict] || null,
      check: deep ? 'Deep check' : verdict && verdict !== 'Error' ? 'Quick check' : null,
      // A quick verdict shown while its deep check runs is a first read, not the answer.
      deepRunning: !deep && verification !== null && verification.status !== 'completed' && verification.status !== 'failed',
      confidence: deep ? null : confidence,
      score: deep && typeof verification.lenz_score === 'number' ? verification.lenz_score : null,
      rewrite: null,
      lines: lines,
      link: null,
      source: null,
      start: firstStart(row.positions),
      occurrences: arr(row.positions).length,
      placed: true,
      placeNote: null,
    };
    if (deep) {
      e.rewrite = str(verification.suggested_rewrite);
      if (!e.rewrite && str(verification.executive_summary)) lines.push({ lead: null, text: verification.executive_summary });
      e.link = lenzPage(verification.url) ? { href: verification.url, words: 'See sources in Lenz' } : null;
    } else if (checking) {
      lines.push({ lead: null, text: 'Checking.' });
    } else if (!verdict || verdict === 'Error') {
      lines.push({ lead: null, text: str(assessment.hint) || 'Could not be checked this time.' });
    } else {
      if (str(assessment.rationale)) lines.push({ lead: "Reviewers' note: ", text: assessment.rationale });
      if (str(assessment.dissent)) lines.push({ lead: 'A reviewer disagreed: ', text: assessment.dissent });
      if (verification !== null && verification.status === 'failed') {
        lines.push({ lead: null, text: deepFailureText(verification) });
      }
    }
    // Re-rendered whenever the block changes; no line while edits are worked out: the verdict's
    // "deep check running" says enough.
    var ed = editsOf(row, opts);
    e.edits = ed.edits;
    e.editsNote = ed.note;
    if (e.occurrences === 0) {
      e.placed = false;
      e.placeNote = 'Lenz could not match this claim to words in the text.';
    }
    return e;
  }

  function citationEntry(row, opts) {
    opts = opts || {};
    var result = isObj(row.result) ? row.result : {};
    var check = isObj(row.check) ? row.check : {};
    var state = citationState(row);
    var group = result.is_issue === true ? 'issue' : state;
    // No finding yet while the review runs and the check has not ended: still being checked.
    var checking = !result.finding && !opts.done && check.status !== 'failed' && check.status !== 'completed';
    if (checking) group = 'pending';
    var finding = FINDINGS[result.finding] || null;
    var lines = [];
    var e = {
      id: 'citation:' + row.index,
      kind: 'citation',
      group: group,
      state: state,
      stateWords: STATE_WORDS[state],
      title: str(row.statement) || str(row.reference) || '',
      // "Not checked" only once the check has ended; a check still running says so (as a claim does).
      label: finding ? finding[0] : checking ? 'Checking' : 'Not checked',
      token: finding ? finding[1] : null,
      check: 'Citation check',
      confidence: null,
      score: null,
      rewrite: null,
      lines: lines,
      link: null,
      deepRunning: false,
      source: sourceLink(row.cited_url) || (str(row.doi) ? sourceLink('https://doi.org/' + row.doi) : null),
      edits: [],
      editsNote: null,
      start: isObj(row.position) && typeof row.position.start === 'number' ? row.position.start : null,
      occurrences: isObj(row.position) && typeof row.position.start === 'number' ? 1 : 0,
      placed: true,
      placeNote: null,
    };
    if (check.status === 'failed') {
      lines.push({ lead: null, text: 'Could not be checked this time.' });
    } else if (result.finding === 'page_not_found') {
      lines.push({ lead: null, text: 'The link returned page not found.' });
    } else if (result.finding === 'doi_not_found') {
      lines.push({ lead: null, text: 'The DOI is not registered with any registry.' });
    } else if (result.finding === 'unchecked' || !result.finding) {
      if (check.status === 'completed') {
        lines.push({ lead: null, text: str(check.hint) || REASONS[check.unchecked_reason] || FALLBACK_REASON });
      } else {
        lines.push({ lead: null, text: checking ? 'Checking.' : 'Could not be checked this time.' });
      }
    }
    if (result.finding === 'quote_not_in_source' && str(check.missing_quote)) {
      lines.push({ lead: 'These quoted words were not found in the source: ', text: check.missing_quote });
    }
    if (result.finding && result.finding !== 'unchecked' && str(check.snippet)) {
      lines.push({ lead: 'The source says: ', text: check.snippet });
    }
    if (str(check.rationale)) lines.push({ lead: "Reviewer's note: ", text: check.rationale });
    if (e.occurrences === 0) {
      e.placed = false;
      e.placeNote = 'Lenz could not match this citation to words in the text.';
    }
    return e;
  }

  // The body's issues[] (compact view): claims with no positions.
  function claimRowsFromIssues(body) {
    return arr(body.issues)
      .filter(isObj)
      .map(function (i) {
        return {
          index: i.claim_index,
          claim: i.claim,
          positions: [],
          result: { verdict: i.verdict, confidence: i.confidence, source: i.source, is_issue: true },
          assessment: { rationale: i.rationale },
          verification: null,
          suggested_edits: i.suggested_edits,
        };
      });
  }

  function compare(a, b) {
    var ga = GROUPS.indexOf(a.group);
    var gb = GROUPS.indexOf(b.group);
    if (ga !== gb) return ga - gb;
    var sa = a.start === null ? Infinity : a.start;
    var sb = b.start === null ? Infinity : b.start;
    if (sa !== sb) return sa - sb;
    if (a.kind !== b.kind) return a.kind === 'claim' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function coverageLines(body, entries, opts) {
    var s = isObj(body.summary) ? body.summary : {};
    var pol = isObj(body.policy) ? body.policy : {};
    var out = [];
    if (s.input_truncated === true || opts.truncated === true) {
      out.push('Only the first part of this tab was checked: it is longer than Lenz reads in one check.');
    }
    var moreClaims = arr(body.more_claims).length;
    if (moreClaims) {
      var cap = typeof s.claim_limit === 'number' ? s.claim_limit : pol.max_assessments;
      out.push(
        plural(moreClaims, 'more claim was', 'more claims were') +
          ' found and not checked' +
          (typeof cap === 'number' ? ' (the limit is ' + cap + ' per check).' : '.')
      );
    }
    var moreCitations = arr(body.more_citations).length;
    if (moreCitations) {
      var ccap = typeof s.citation_limit === 'number' ? s.citation_limit : pol.max_citations;
      out.push(
        plural(moreCitations, 'more citation was', 'more citations were') +
          ' found and not checked' +
          (typeof ccap === 'number' ? ' (the limit is ' + ccap + ' per check).' : '.')
      );
    }
    var a = isObj(s.assessments) ? s.assessments : {};
    if (a.failed > 0) out.push(plural(a.failed, 'claim', 'claims') + ' could not be checked this time.');
    var v = isObj(s.verifications) ? s.verifications : {};
    var thin = Math.min(countTooFewSources(body), v.failed > 0 ? v.failed : 0);
    if (thin > 0) {
      out.push(plural(thin, 'claim', 'claims') + ' had too few public sources for a deep check; ' + (thin === 1 ? 'it shows' : 'they show') + ' the quick verdict.');
    }
    var rest = v.failed > 0 ? v.failed - thin : 0;
    if (rest > 0) {
      out.push(plural(rest, 'deep check', 'deep checks') + ' did not finish; ' + (rest === 1 ? 'that claim shows its' : 'those claims show their') + ' quick verdict.');
    }
    var c = isObj(s.citation_checks) ? s.citation_checks : {};
    if (c.unchecked > 0) {
      out.push(plural(c.unchecked, 'citation', 'citations') + ' could not be checked: the reason is under each one.');
    }
    if (c.failed > 0) {
      out.push(plural(c.failed, 'citation check', 'citation checks') + ' failed this time.');
    }
    if (str(s.citations_skipped)) out.push(SKIPPED[s.citations_skipped] || 'Citations were not checked.');
    var unplaced = entries.filter(function (e) {
      return !e.placed;
    }).length;
    if (unplaced) {
      out.push(
        plural(unplaced, 'finding', 'findings') +
          (unplaced === 1 ? ' is' : ' are') +
          ' not in the Doc as it is now, so ' +
          (unplaced === 1 ? 'it' : 'they') +
          ' cannot be selected.'
      );
    }
    var notRead = isObj(opts.notRead) ? opts.notRead : {};
    var parts = [];
    NOT_READ.forEach(function (n) {
      var k = notRead[n[0]];
      if (typeof k === 'number' && k > 0) parts.push(plural(k, n[1], n[2]));
    });
    if (parts.length) out.push('Not read: ' + parts.join(', ') + '.');
    if (retryHelps(body)) out.push('Some checks did not finish. Choose Check this Doc to try them again.');
    return out;
  }

  function headline(body, groups, coverage) {
    if (body.status === 'failed') return 'The check did not finish.';
    if (body.status !== 'completed') return null;
    var n = groups.issue.length;
    if (n) return plural(n, 'issue', 'issues') + ' to look at.';
    if (groups.look.length) return 'No issues found. Some findings need a closer look.';
    if (body.outcome === 'clean' && coverage.length === 0) return 'No issues found.';
    return 'No issues among what was checked.';
  }

  function progress(body) {
    if (body.status === 'completed' || body.status === 'failed') return null;
    var words = PROGRESS[body.status] || PROGRESS.queued;
    var v = isObj(body.summary) && isObj(body.summary.verifications) ? body.summary.verifications : null;
    if (body.status === 'verifying' && v && v.planned > 0) {
      words = 'Running ' + plural(v.planned, 'deep check', 'deep checks') + ' (' + ((v.completed || 0) + (v.failed || 0)) + ' done)';
    }
    return words;
  }

  // What a running review has done so far, stage by stage (no percentage):
  // the quick checks of the claims found, the deep checks planned, the
  // citation checks. A stage appears once it applies; failures count as done
  // (the coverage lines report them). Null once the review is terminal.
  function stages(body) {
    if (body.status === 'completed' || body.status === 'failed') return null;
    var s = isObj(body.summary) ? body.summary : {};
    function stage(key, label, done, total) {
      return { key: key, label: label, done: done, total: total, complete: total > 0 && done >= total };
    }
    function n(x) { return typeof x === 'number' ? x : 0; }
    if (typeof s.claims_selected !== 'number') {
      return [{ key: 'reading', label: 'Finding the claims', done: null, total: null, complete: false }];
    }
    var out = [];
    var a = isObj(s.assessments) ? s.assessments : {};
    if (s.claims_selected > 0) out.push(stage('quick', 'Quick checks', n(a.completed) + n(a.failed), s.claims_selected));
    var v = isObj(s.verifications) ? s.verifications : null;
    if (v && v.planned > 0) out.push(stage('deep', 'Deep checks', n(v.completed) + n(v.failed), v.planned));
    var c = isObj(s.citation_checks) ? s.citation_checks : {};
    if (typeof s.citations_selected === 'number' && s.citations_selected > 0) {
      out.push(stage('citations', 'Citation checks', n(c.checked) + n(c.unchecked) + n(c.failed), s.citations_selected));
    }
    return out;
  }

  function failureText(body) {
    if (body.status !== 'failed') return null;
    var f = isObj(body.failure) ? body.failure : {};
    return str(f.hint) || 'Lenz could not finish this check. Choose Check this Doc to try again.';
  }

  function build(body, opts) {
    opts = isObj(opts) ? opts : {};
    var o = {
      applied: isObj(opts.applied) ? opts.applied : {},
      appliedEdits: arr(opts.appliedEdits),
      unplaced: isObj(opts.unplaced) ? opts.unplaced : {},
      notRead: opts.notRead,
      truncated: opts.truncated,
    };
    body = isObj(body) ? body : {};
    o.done = body.status === 'completed' || body.status === 'failed';
    o.suggestEdits = isObj(body.policy) && body.policy.suggest_edits === true;
    var claimRows = Array.isArray(body.claims) ? body.claims : claimRowsFromIssues(body);
    var entries = [];
    claimRows.forEach(function (row) {
      if (isObj(row) && typeof row.index === 'number') entries.push(claimEntry(row, o));
    });
    arr(body.citations).forEach(function (row) {
      if (isObj(row) && typeof row.index === 'number') entries.push(citationEntry(row, o));
    });
    entries.forEach(function (e) {
      if (e.placed && o.unplaced[e.id]) {
        e.placed = false;
        e.placeNote = 'The words changed since the check.';
      }
    });
    entries.sort(compare);
    var groups = { issue: [], look: [], pending: [], none: [], ok: [] };
    entries.forEach(function (e) {
      groups[e.group].push(e);
    });
    var coverage = coverageLines(body, entries, o);
    var quick = entries.some(function (e) {
      return e.group !== 'ok' && e.check === 'Quick check';
    });
    var charged = isObj(body.credits) && typeof body.credits.charged === 'number' ? body.credits.charged : null;
    return {
      reviewId: str(body.review_id),
      status: str(body.status) || 'queued',
      done: body.status === 'completed' || body.status === 'failed',
      progress: progress(body),
      stages: stages(body),
      headline: headline(body, groups, coverage),
      failure: failureText(body),
      groups: GROUPS.map(function (g) {
        // "Checks out" folds only behind something to look at; a clean Doc shows what was checked.
        var fold = g === 'ok' && (groups.issue.length > 0 || groups.look.length > 0);
        return { key: g, title: GROUP_TITLES[g], collapsed: fold, count: groups[g].length, entries: groups[g] };
      }).filter(function (g) {
        return g.count > 0;
      }),
      coverage: coverage,
      footnote: quick ? 'A quick verdict is a first read. A deep check shows the sources and can change it.' : null,
      charged: charged === null ? null : 'Charged ' + plural(charged, 'credit', 'credits') + '.',
    };
  }

  function parseId(entryId) {
    var m = /^(claim|citation):(\d+)$/.exec(String(entryId));
    return m ? { kind: m[1], index: Number(m[2]) } : null;
  }

  function rowAt(list, index) {
    var found = null;
    arr(list).forEach(function (r) {
      if (isObj(r) && r.index === index) found = r;
    });
    return found;
  }

  // An entry id -> its row in a fresh review body: { kind, row } or null. The
  // glue turns the row into a target with LenzPlace.claimTarget / citationTarget.
  function row(body, entryId) {
    var id = parseId(entryId);
    if (!id || !isObj(body)) return null;
    var r = rowAt(id.kind === 'claim' ? body.claims : body.citations, id.index);
    return r ? { kind: id.kind, row: r } : null;
  }

  // Every claim and citation row of a body, by entry id, for the placement pass.
  function rows(body) {
    var out = [];
    if (!isObj(body)) return out;
    arr(body.claims).forEach(function (r) {
      if (isObj(r) && typeof r.index === 'number') out.push({ id: 'claim:' + r.index, kind: 'claim', row: r });
    });
    arr(body.citations).forEach(function (r) {
      if (isObj(r) && typeof r.index === 'number') out.push({ id: 'citation:' + r.index, kind: 'citation', row: r });
    });
    return out;
  }

  return {
    build: build,
    row: row,
    rows: rows,
    claimState: claimState,
    citationState: citationState,
    STATE_WORDS: STATE_WORDS,
    editFp: editFp,
    retryHelps: retryHelps,
  };
})();
if (typeof module !== 'undefined') {
  module.exports = LenzView;
}
