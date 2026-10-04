// Test-only: a hand-built Serialized for cases fake-docs does not model (suggested and atomic
// characters, via opts.flags). Everything else reads a fake-docs Doc through the real serialize().
// From plain review text: paragraphs split on "\n\n", one text
// piece per paragraph, the separators synthetic, and every `[words](url)` split into synthetic
// brackets around a link-flagged text piece. REST indexes: body starts at 1, each paragraph ends
// with its own "\n" (u16), as in a real Docs body.
'use strict';

var S = require('../../src/serialize.js');
var cpLength = S.cpLength;
var cpSlice = S.cpSlice;

var LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;

// opts.flags: [{start, end, flag}] in cp of the text: mark that range's text pieces (splitting them).
function fakeSerialized(text, opts) {
  opts = opts || {};
  var pieces = [];
  var paras = text.split('\n\n');
  var cp = 0;
  var ds = 1;
  paras.forEach(function (para, p) {
    if (p > 0) {
      pieces.push({ rs: cp, re: cp + 2, ds: null, de: null, kind: 'synthetic',
                    flags: { suggested: false, atomic: false, link: false }, para: p - 1 });
      cp += 2;
    }
    var at = 0;
    var m;
    LINK.lastIndex = 0;
    function push(str, kind, link) {
      if (!str) return;
      var n = cpLength(str);
      var piece = { rs: cp, re: cp + n, ds: null, de: null, kind: kind,
                    flags: { suggested: false, atomic: false, link: !!link }, para: p };
      if (kind === 'text') { piece.ds = ds; piece.de = ds + str.length; ds += str.length; }
      pieces.push(piece);
      cp += n;
    }
    while ((m = LINK.exec(para)) !== null) {
      push(para.slice(at, m.index), 'text');
      push('[', 'synthetic');
      push(m[1], 'text', true);
      push('](' + m[2] + ')', 'synthetic');
      at = m.index + m[0].length;
    }
    push(para.slice(at), 'text');
    ds += 1; // the paragraph's own newline in the REST body
  });
  (opts.flags || []).forEach(function (f) { pieces = markRange(text, pieces, f.start, f.end, f.flag); });
  return {
    text: text, textHash: null, tabId: 't.0', revisionId: 'rev-1', truncated: false,
    notRead: { footnotes: 0, headers: 0, footers: 0, images: 0, equations: 0, otherChips: 0, otherTabs: 0 },
    pieces: pieces
  };
}

function splitPiece(text, piece, at) {
  if (at <= piece.rs || at >= piece.re) return [piece];
  var a = Object.assign({}, piece, { flags: Object.assign({}, piece.flags), re: at });
  var b = Object.assign({}, piece, { flags: Object.assign({}, piece.flags), rs: at });
  if (piece.kind === 'text') {
    var u = cpSlice(text, piece.rs, at).length;
    a.de = piece.ds + u;
    b.ds = piece.ds + u;
  }
  return [a, b];
}

function markRange(text, pieces, start, end, flag) {
  var out = [];
  pieces.forEach(function (p) {
    splitPiece(text, p, start).forEach(function (q) {
      splitPiece(text, q, end).forEach(function (r) {
        if (r.kind === 'text' && r.rs >= start && r.re <= end) r.flags[flag] = true;
        out.push(r);
      });
    });
  });
  return out;
}

module.exports = { fakeSerialized: fakeSerialized };
