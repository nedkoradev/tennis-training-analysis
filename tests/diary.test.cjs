const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { setImmediate: settle } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');

const page = readFileSync(path.join(__dirname, '..', 'matches.html'), 'utf8');
const moduleSource = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^import .+$/gm, '');
const garminSource = readFileSync(path.join(__dirname, '..', 'garmin.html'), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1];

function cloud() {
  const documents = new Map();
  const listeners = new Map();
  const writes = [];
  const snapshot = (ref, metadata = {}) => {
    const data = structuredClone(documents.get(ref));
    return { exists: () => data !== undefined, data: () => data, metadata };
  };
  const emit = (ref, metadata) => listeners.get(ref)?.forEach(callback => callback(snapshot(ref, metadata)));
  return {
    documents, writes, emit,
    subscribe(ref, options, callback) {
      assert.equal(options.includeMetadataChanges, true);
      if (!listeners.has(ref)) listeners.set(ref, new Set());
      listeners.get(ref).add(callback);
      return () => listeners.get(ref).delete(callback);
    },
    async transaction(_, callback) {
      if (this.wait) await this.wait;
      if (this.offline) throw Error('No connection');
      // Retry if a concurrent write changes the document between read and commit.
      for (;;) {
        let ref, observed, next;
        await callback({
          get(path) { ref = path; observed = documents.get(ref); return snapshot(ref); },
          set(path, data, options) {
            assert.equal(path, ref);
            assert.equal(options.merge, true);
            next = structuredClone(data);
          },
        });
        if (documents.get(ref) !== observed) continue;
        if (next) {
          documents.set(ref, { ...observed, ...next });
          writes.push(ref);
          emit(ref);
          if (this.lostAck) {
            this.lostAck = false;
            throw Error('Connection dropped after commit');
          }
        }
        return;
      }
    },
  };
}

function client(remote, storage = new Map()) {
  const elements = new Map();
  const input = () => ({ value: '' });
  const element = id => {
    if (!elements.has(id)) {
      const node = {
        id, value: '', textContent: '', innerHTML: '', style: {}, children: [], options: [],
        classList: { toggle() {} }, addEventListener() {}, reset() {}, hidden: false,
        append(row) { this.children.push(row); }, appendChild(row) { this.children.push(row); },
        replaceChildren() { this.innerHTML = ''; this.children.length = 0; },
        showModal() { this.open = true; }, close() { this.open = false; }, click() {},
      };
      let markup = '';
      Object.defineProperty(node, 'innerHTML', {
        get: () => markup,
        set(value) { markup = value; node.children.length = 0; },
      });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  let authChange, timerId = 0;
  const context = vm.createContext({
    document: {
      getElementById: element, querySelectorAll: () => [],
      createElement: () => ({ querySelector: () => ({}), querySelectorAll: () => [input(), input()], click() {} }),
    },
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    initializeApp() {}, getAuth() {}, getFirestore() {}, closeDatePopup() {},
    formatDateBG: value => value,
    doc: (_, ...path) => path.join('/'),
    onAuthStateChanged: (_, callback) => { authChange = callback; },
    onSnapshot: remote.subscribe.bind(remote),
    runTransaction: remote.transaction.bind(remote),
    crypto: { randomUUID }, structuredClone, confirm: () => true, prompt: () => 'Test opponent',
    alert() {}, URL, Blob, setTimeout: () => ++timerId, clearTimeout() {},
  });
  const run = expression => vm.runInContext(expression, context);
  run(moduleSource);
  return {
    element, run, storage,
    data: () => JSON.parse(run('JSON.stringify({matches,players,garminActivities,hrSeries})')),
    auth: uid => authChange(uid ? { uid, displayName: uid } : null),
    form(sets, tiebreak) {
      element('opponent').value = 'p1';
      element('matchDate').value = '2026-02-01';
      element('surface').value = 'Clay';
      element('matchTiebreak').checked = Boolean(tiebreak);
      element('tbMine').value = tiebreak?.[0].toString() ?? '';
      element('tbTheirs').value = tiebreak?.[1].toString() ?? '';
      element('setRows').children = sets.map(pair => ({ querySelectorAll: () => pair.map(value => ({ value: String(value) })) }));
      element('matchForm').onsubmit({ preventDefault() {} });
    },
  };
}

const ref = uid => 'users/' + uid + '/tennis/diary';
const pendingKey = uid => 'tennis_diary_pending_v1_' + uid;
const hrKey = 'tennis_hr_series_v1';
const diary = (overrides = {}) => ({
  players: [{ id: 'p1', name: 'Synthetic opponent' }],
  matches: [], garminActivities: [], updatedAt: 'previous', ...overrides,
});
function connect(view, remote, uid = 'a') {
  view.auth(uid);
  remote.emit(ref(uid));
}

test('logout and account switch clear details, Garmin series, imports, and stale async work', async () => {
  const remote = cloud();
  const match = { id: 'm1', playerId: 'p1', date: '2026-01-01', sets: [[6, 3]], garmin: { id: 'fit-a' } };
  remote.documents.set(ref('a'), diary({ matches: [match], garminActivities: [{ id: 'a-only', date: '2026-01-01' }] }));
  remote.documents.set(ref('b'), diary({ garminActivities: [{ id: 'b-only', date: '2027-01-01' }] }));
  const legacy = { 'fit-a': [[0, 100], [15, 110]], unrelated: [[0, 120]] };
  const storage = new Map([[hrKey, JSON.stringify(legacy)], [hrKey + '_b', '{"fit-b":[[0,90],[15,95]]}']]);
  const view = client(remote, storage);
  connect(view, remote);
  assert.deepEqual(view.data().hrSeries, {});
  view.element('recoverHr').onclick();
  assert.deepEqual(view.data().hrSeries, { 'fit-a': legacy['fit-a'] });
  view.run("openMatchDetails('m1')");
  assert.match(view.element('matchDetailsBody').innerHTML, /matchHrGraph/);
  let finishFile;
  const file = { text: () => new Promise(resolve => { finishFile = resolve; }) };
  const importJob = view.element('hrImportFile').onchange({ target: { files: [file] } });
  view.auth(null);
  assert.deepEqual(view.data(), { matches: [], players: [], garminActivities: [], hrSeries: {} });
  assert.equal(view.element('matchDetails').open, false);
  assert.equal(view.element('matchDetailsBody').innerHTML, '');
  assert.equal(view.element('matchDetailsActions').innerHTML, '');
  connect(view, remote, 'b');
  finishFile('{"version":1,"activities":{"stale":[]}}');
  await importJob;
  assert.deepEqual(view.data().garminActivities.map(a => a.id), ['b-only']);
  assert.deepEqual(Object.keys(view.data().hrSeries), ['fit-b']);
  assert.deepEqual(JSON.parse(storage.get(hrKey)), legacy);
  assert.deepEqual(Object.keys(JSON.parse(storage.get(hrKey + '_a'))), ['fit-a']);
  assert.equal(remote.writes.length, 0);
});

test('validates completed sets and deciding tiebreak and saves in the existing Firestore format', async () => {
  const remote = cloud();
  const stored = { id: 'old', playerId: 'p1', date: '2025-04-01', sets: [{ mine: 7, theirs: 6 }], garmin: { id: 'old-fit' } };
  remote.documents.set(ref('a'), diary({ matches: [stored], futureField: 'keep' }));
  const view = client(remote);
  connect(view, remote);
  assert.deepEqual(view.data().matches[0].sets, [[7, 6]]);
  view.form([[6, 4], [4, 6]], [10, 9]);
  assert.match(view.element('formError').textContent, /10/);
  view.form([[5, 4], [4, 6]], [10, 8]);
  assert.match(view.element('formError').textContent, /сет/);
  view.form([[6, 4], [4, 6]], [10, 8]);
  assert.equal(view.run('outcome(matches.at(-1)).result'), 'win');
  assert.ok(view.storage.has(pendingKey('a')));
  await view.run('sync()');
  const result = remote.documents.get(ref('a'));
  assert.deepEqual(result.matches[0], stored);
  assert.deepEqual(result.matches[1].sets, [{ mine: 6, theirs: 4 }, { mine: 4, theirs: 6 }]);
  assert.deepEqual(result.matches[1].matchTiebreak, [10, 8]);
  assert.equal(result.futureField, 'keep');
  assert.equal(view.storage.has(pendingKey('a')), false);
});

test('FIT extensions are case-insensitive and filter years include 2025, 2026 and 2027', () => {
  const remote = cloud();
  remote.documents.set(ref('a'), diary({
    garminActivities: ['2025-01-02', '2026-02-01', '2027-03-01', 'bad-date'].map(date => ({ id: date, date })),
  }));
  const view = client(remote);
  connect(view, remote);
  assert.match(view.element('trainingYear').innerHTML, /2027.*2026.*2025/);
  assert.doesNotMatch(view.element('trainingYear').innerHTML, /bad/);
  view.element('trainingYear').value = '2026';
  view.run('renderTraining()');
  assert.match(view.element('trainingList').innerHTML, /2026-02-01/);
  assert.doesNotMatch(view.element('trainingList').innerHTML, /2025|2027/);
  const context = vm.createContext({ document: { getElementById: view.element }, localStorage: { getItem: () => null } });
  vm.runInContext(garminSource, context);
  const chosen = vm.runInContext("chooseFitFiles(['activity.fit','Match.FIT','a.b.fit','fit','activity.fit.zip','activity.fitx'].map(name=>({name}))).map(file=>file.name)", context);
  assert.deepEqual(Array.from(chosen), ['activity.fit', 'Match.FIT', 'a.b.fit']);
});

test('two devices keep the winning cloud record and retain a stale local draft across logout', async () => {
  const remote = cloud();
  remote.documents.set(ref('a'), diary());
  const one = client(remote), two = client(remote);
  connect(one, remote);
  connect(two, remote);
  one.form([[6, 4]], null);
  two.form([[4, 6]], null);
  await Promise.all([one.run('sync()'), two.run('sync()')]);
  const winner = one.run('conflict') ? two : one;
  const loser = winner === one ? two : one;
  assert.equal(remote.writes.length, 1);
  assert.equal(loser.run('conflict'), true);
  assert.equal(loser.element('acceptCloud').hidden, false);
  assert.notEqual(loser.data().matches[0].sets[0][0], winner.data().matches[0].sets[0][0]);
  loser.auth(null);
  assert.equal(loser.data().matches.length, 0);
  const reopened = client(remote, loser.storage);
  connect(reopened, remote);
  await settle();
  assert.equal(reopened.run('conflict'), true);
  assert.equal(reopened.data().matches.length, 1);
  assert.equal(remote.writes.length, 1);
  reopened.element('acceptCloud').onclick();
  assert.equal(reopened.storage.has(pendingKey('a')), false);
  assert.ok([...reopened.storage.keys()].some(key => key.startsWith(pendingKey('a') + '_backup_')));
  assert.deepEqual(reopened.data().matches, winner.data().matches);
});

test('ignores offline snapshots and retains unsent changes when losing connectivity or switching accounts', async () => {
  const remote = cloud();
  remote.documents.set(ref('a'), diary());
  const view = client(remote);
  view.auth('a');
  remote.emit(ref('a'), { fromCache: true });
  assert.equal(view.run('ready'), false);
  remote.emit(ref('a'));
  view.form([[6, 2]], null);
  remote.offline = true;
  await view.run('sync()');
  assert.equal(view.storage.has(pendingKey('a')), true);
  assert.equal(view.element('syncRecovery').hidden, false);
  remote.offline = false;
  let release;
  remote.wait = new Promise(resolve => { release = resolve; });
  const job = view.run('sync()');
  connect(view, remote, 'b');
  release();
  await job;
  assert.deepEqual(remote.writes, []);
  assert.deepEqual(view.data().matches, []);
  assert.equal(view.storage.has(pendingKey('a')), true);
  connect(view, remote);
  await settle();
  assert.equal(remote.documents.get(ref('a')).matches.length, 1);
  assert.equal(view.storage.has(pendingKey('a')), false);
});

test('recovers from a lost acknowledgement with later local edits still pending', async () => {
  const remote = cloud();
  remote.documents.set(ref('a'), diary());
  const view = client(remote);
  connect(view, remote);
  view.form([[6, 1]], null);
  remote.lostAck = true;
  await view.run('sync()');
  assert.equal(view.storage.has(pendingKey('a')), true);
  view.form([[6, 2]], null);
  await view.run('sync()');
  assert.equal(remote.documents.get(ref('a')).matches.length, 2);
  assert.equal(view.storage.has(pendingKey('a')), false);
});

test('a snapshot invalidates a match form opened on an older cloud copy', () => {
  const remote = cloud();
  const match = { id: 'm1', playerId: 'p1', date: '2026-01-01', sets: [[6, 3]], notes: 'old' };
  remote.documents.set(ref('a'), diary({ matches: [match] }));
  const view = client(remote);
  connect(view, remote);
  view.run("editMatch('m1')");
  assert.equal(view.run('editing'), 'm1');
  remote.emit(ref('a'));
  assert.equal(view.run('editing'), 'm1');
  remote.documents.set(ref('a'), diary({ matches: [{ ...match, notes: 'new' }] }));
  remote.emit(ref('a'));
  assert.equal(view.run('editing'), null);
  assert.match(view.element('formError').textContent, /променен/);
  assert.equal(view.data().matches[0].notes, 'new');
});

test('slow sync keeps a second local edit queued without replacing it with a snapshot', async () => {
  const remote = cloud();
  remote.documents.set(ref('a'), diary());
  const view = client(remote);
  connect(view, remote);
  view.form([[6, 1]], null);
  let release;
  remote.wait = new Promise(resolve => { release = resolve; });
  const job = view.run('sync()');
  view.form([[6, 2]], null);
  remote.emit(ref('a'), { hasPendingWrites: true });
  assert.equal(view.data().matches.length, 2);
  release();
  await job;
  assert.equal(remote.documents.get(ref('a')).matches.length, 1);
  assert.equal(view.data().matches.length, 2);
  assert.equal(view.storage.has(pendingKey('a')), true);
  await view.run('sync()');
  assert.equal(remote.documents.get(ref('a')).matches.length, 2);
  assert.equal(view.storage.has(pendingKey('a')), false);
});

test('home renders the eight latest matches and preserves the full history', () => {
  const remote = cloud();
  const matches = [2, 9, 7, 1, 5, 3, 8, 6, 4].map(day => ({
    id: 'match-' + day,
    playerId: 'p1',
    date: '2026-01-0' + day,
    sets: [[6, 4], [6, 7]],
    matchTiebreak: [12, 10],
    garmin: { avg_hr: 139 },
  }));
  const view = client(remote);
  connect(view, remote);
  assert.match(view.element('recent').innerHTML, /Последните ти мачове/);

  remote.documents.set(ref('a'), diary({ matches }));
  remote.emit(ref('a'));
  const recent = view.element('recent');
  const ids = [...recent.innerHTML.matchAll(/data-match-id="(.*?)"/g)].map(match => match[1]);
  assert.deepEqual(ids, [9, 8, 7, 6, 5, 4, 3, 2].map(day => 'match-' + day));
  assert.match(recent.innerHTML, /6:4, 6:7, TB 12:10/);
  assert.equal((view.element('historyList').innerHTML.match(/class="match-tile"/g) || []).length, 9);
  recent.onclick({ target: { closest: () => ({ dataset: { matchId: 'match-7' } }) } });
  assert.equal(view.element('matchDetails').open, true);
  assert.match(view.element('matchDetailsBody').innerHTML, /139 bpm/);

  remote.documents.set(ref('a'), diary({ matches: matches.slice(0, 2) }));
  remote.emit(ref('a'));
  assert.equal((recent.innerHTML.match(/class="recent-match"/g) || []).length, 2);
});
