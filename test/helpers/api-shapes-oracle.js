// Writes the frozen oracle for test/api-shapes.test.js: what the add-on produced from each answer
// before it stopped reading the API's older answer shape. It runs the add-on code of ORACLE_COMMIT,
// never the code under test:
//
//   git worktree add --detach /tmp/gdocs-oracle b070a9ce7149299f3b7cc2120b6bcf590b9b2f52
//   node test/helpers/api-shapes-oracle.js /tmp/gdocs-oracle
//   git worktree remove /tmp/gdocs-oracle
//
// It refuses a checkout at any other commit. At that commit the add-on read both shapes, and its own
// tests held each answer here equal to what the add-on produced before it read the current shape at
// all (commit cea222bcc01170a5abfec085584bd62d6897f957), so the files did not change when it was re-run.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ORACLE_COMMIT = 'b070a9ce7149299f3b7cc2120b6bcf590b9b2f52';
const DIR = path.join(__dirname, '..', 'fixtures', 'api-shapes');

// What the oracle records for one answer, given the add-on's two modules.
function produce(view, api, name, r) {
  if (name.startsWith('get_')) return { build: view.build(r.body) };
  return { describeError: api.describeError(r.status, {}, JSON.stringify(r.body)) };
}

function main(checkout) {
  const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== ORACLE_COMMIT) throw new Error('the oracle runs only at ' + ORACLE_COMMIT + '; ' + checkout + ' is at ' + head);
  const view = require(path.resolve(checkout, 'src', 'view.js'));
  const api = require(path.resolve(checkout, 'src', 'api.js'));
  for (const file of fs.readdirSync(DIR).filter((n) => n.startsWith('canonical.')).sort()) {
    const name = file.slice('canonical.'.length, -'.json'.length);
    const r = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    fs.writeFileSync(path.join(DIR, 'expected.' + name + '.json'), JSON.stringify(produce(view, api, name, r), null, 2) + '\n');
  }
}

module.exports = { produce, ORACLE_COMMIT };
if (require.main === module) main(process.argv[2]);
