#!/usr/bin/env node
// Reads what the spike's Apps Script functions returned (the `clasp run` output, saved to files) and
// prints PASS / FAIL per spike item and per ⚑ item of CONTRACT.md.
//
//   node scripts/spike-report.js tmp/spike/check.txt [tmp/spike/egress.txt] [tmp/spike/latency.txt]
//        [--parity CMD]    run `CMD <file.docx>`, which prints the text Lenz's .docx reader gives
//                          for the Doc's .docx export (item 5 and the ⚑ items; needs Lenz's reader)
//        [--save]          write the REST dump as test/fixtures/docs/real-spike.json, and the .docx
//                          + its reader text as test/fixtures/parity/real-spike.{docx,txt}
//        [--json]          print the verdict as JSON
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const LenzSpike = require('../src/spike.js');

const ROOT = path.join(__dirname, '..');

// A saved `clasp run` output: the JSON string the function returned, plain, quoted, wrapped in
// other lines, or inside `clasp run --json`'s { response, error }.
function parseRunOutput(raw) {
  const text = raw.trim();
  const tries = [text];
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  const q = text.indexOf('"{');
  if (q >= 0) tries.push(text.slice(q, text.lastIndexOf('}"') + 2));
  for (const t of tries) {
    try {
      let v = JSON.parse(t);
      if (v && typeof v === 'object' && !v.kind) {
        // `clasp run --json`: { response, error }, `response` absent when the function threw.
        if (v.error) throw new Error('the function failed: ' + JSON.stringify(v.error));
        if ('response' in v) v = v.response;
      }
      if (typeof v === 'string') v = JSON.parse(v);
      if (v && typeof v === 'object' && v.kind) return v;
    } catch (e) {
      if (/the function failed/.test(e.message)) throw e;
    }
  }
  throw new Error('no spike JSON in this output');
}

function parseArgs(argv) {
  const args = { files: [], parity: null, save: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--parity') args.parity = argv[++i];
    else if (argv[i] === '--save') args.save = true;
    else if (argv[i] === '--json') args.json = true;
    else args.files.push(argv[i]);
  }
  return args;
}

// The reference text for a .docx: `CMD <file.docx>` through bash, its stdout as is.
function parityText(cmd, docxPath) {
  return execFileSync('bash', ['-c', cmd + ' "$1"', 'parity', docxPath],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function report(outputs, opts) {
  const byKind = {};
  for (const o of outputs) byKind[o.kind] = o;
  const check = byKind['lenz-spike-check'];
  if (!check) throw new Error('no lenz-spike-check output given');
  const extras = { egress: byKind['lenz-spike-egress'], latency: byKind['lenz-spike-latency'] };
  if (opts.parityText !== undefined) extras.parityText = opts.parityText;
  return LenzSpike.evaluate(check, extras);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files.length) {
    console.error('usage: spike-report.js CHECK.txt [EGRESS.txt] [LATENCY.txt] [--parity CMD] [--save] [--json]');
    process.exit(2);
  }
  const outputs = args.files.map((f) => parseRunOutput(fs.readFileSync(f, 'utf8')));
  const check = outputs.find((o) => o.kind === 'lenz-spike-check');
  const opts = {};
  let docxPath = null;
  if (check && check.docx) {
    fs.mkdirSync(path.join(ROOT, 'tmp', 'spike'), { recursive: true });
    docxPath = path.join(ROOT, 'tmp', 'spike', 'spike.docx');
    fs.writeFileSync(docxPath, Buffer.from(check.docx, 'base64'));
    if (args.parity) opts.parityText = parityText(args.parity, docxPath);
  }
  const result = report(outputs, opts);
  if (args.save && check) {
    fs.writeFileSync(path.join(ROOT, 'test', 'fixtures', 'docs', 'real-spike.json'), JSON.stringify(check.dump, null, 2) + '\n');
    if (docxPath && opts.parityText !== undefined) {
      fs.copyFileSync(docxPath, path.join(ROOT, 'test', 'fixtures', 'parity', 'real-spike.docx'));
      fs.writeFileSync(path.join(ROOT, 'test', 'fixtures', 'parity', 'real-spike.txt'), opts.parityText);
    }
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('review text: ' + result.ser.chars + ' cp, ' + result.ser.pieces + ' pieces, notRead ' +
      JSON.stringify(result.ser.notRead));
    for (const it of result.items) {
      console.log(`\n[${it.status}] ${it.id}  ${it.title}`);
      if (it.detail !== undefined) console.log('  ' + JSON.stringify(it.detail, null, 2).split('\n').join('\n  '));
    }
  }
  process.exitCode = result.items.some((i) => i.status === 'FAIL') ? 1 : 0;
}

if (require.main === module) main();

module.exports = { parseRunOutput, report };
