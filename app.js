// ====== CONFIG: edit this to your CouchDB movies database URL ======
// Include credentials if needed, e.g. http://admin:password@localhost:5984/movies
const COUCHDB_URL = 'http://admin:mtu12345@192.168.1.41:5984/schema_a_movies';
// ===================================================================

// Local browser database (IndexedDB). All CRUD goes here first, so it works offline.
const localDB = new PouchDB('movies');

const statusEl = document.getElementById('status');
const form = document.getElementById('movie-form');
const listEl = document.getElementById('movie-list');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');

// ---------- Helpers ----------
// "a, b, c" -> ["a","b","c"]
function toArray(text) {
  return text.split(',').map(s => s.trim()).filter(s => s !== '');
}

// Unique _id for new movies (timestamp + random suffix)
function newId() {
  return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ---------- CREATE / UPDATE ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('movie-id').value;
  // Schema A: _id, title, actors[], genres[]
  const movie = {
    title: document.getElementById('title').value.trim(),
    actors: toArray(document.getElementById('actors').value),
    genres: toArray(document.getElementById('genres').value)
  };

  if (id) {
    // UPDATE: fetch the latest doc to get its current _rev, then put it back
    const doc = await localDB.get(id);
    movie._id = doc._id;
    movie._rev = doc._rev;
    await localDB.put(movie);
  } else {
    // CREATE: new document with a generated unique _id
    movie._id = newId();
    await localDB.put(movie);
  }
  resetForm();
  showMovies();
});

// ---------- READ ----------
async function showMovies() {
  // conflicts:true adds a _conflicts array to docs that have conflicting revisions
  const result = await localDB.allDocs({ include_docs: true, conflicts: true });
  const term = searchEl.value.trim().toLowerCase();
  const matches = result.rows
    .map(r => r.doc)
    .filter(d => !d._id.startsWith('_design') && (d.title || '').toLowerCase().includes(term));

  conflictCount = result.rows.filter(r => r.doc && r.doc._conflicts && r.doc._conflicts.length).length;
  renderStatus();

  // Show conflicted movies first, then limit the list so the page stays fast
  matches.sort((a, b) => (b._conflicts ? 1 : 0) - (a._conflicts ? 1 : 0));
  countEl.textContent = matches.length + ' movie(s) found';

  listEl.innerHTML = '';
  matches.slice(0, 50).forEach(doc => {
    const li = document.createElement('li');
    const hasConflict = doc._conflicts && doc._conflicts.length > 0;
    li.className = hasConflict ? 'card conflict' : 'card';

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = doc.title;
    li.appendChild(titleEl);

    const actorsEl = document.createElement('div');
    actorsEl.className = 'actors';
    actorsEl.textContent = 'Starring: ' + (doc.actors || []).join(', ');
    li.appendChild(actorsEl);

    const genresEl = document.createElement('div');
    (doc.genres || []).forEach(g => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = g;
      genresEl.appendChild(tag);
    });
    li.appendChild(genresEl);

    // CONFLICT DETECTION: _conflicts lists losing revisions of this doc
    if (hasConflict) {
      const warn = document.createElement('div');
      warn.className = 'warning';
      warn.textContent = 'WARNING: conflict detected (' + doc._conflicts.length + ' conflicting revision(s))';
      li.appendChild(warn);

      const resolveBtn = document.createElement('button');
      resolveBtn.textContent = 'Keep this version (resolve)';
      resolveBtn.className = 'warn';
      resolveBtn.onclick = () => resolveConflict(doc);
      li.appendChild(resolveBtn);
    }

    const btns = document.createElement('div');
    btns.className = 'card-buttons';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => startEdit(doc);
    btns.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    delBtn.onclick = () => deleteMovie(doc);
    btns.appendChild(delBtn);
    li.appendChild(btns);

    listEl.appendChild(li);
  });
}
searchEl.addEventListener('input', showMovies);

// ---------- Edit form handling ----------
function startEdit(doc) {
  document.getElementById('movie-id').value = doc._id;
  document.getElementById('title').value = doc.title;
  document.getElementById('actors').value = (doc.actors || []).join(', ');
  document.getElementById('genres').value = (doc.genres || []).join(', ');
  document.getElementById('form-title').textContent = 'Edit Movie';
  document.getElementById('cancel-btn').hidden = false;
}
function resetForm() {
  form.reset();
  document.getElementById('movie-id').value = '';
  document.getElementById('form-title').textContent = 'Add Movie';
  document.getElementById('cancel-btn').hidden = true;
}
document.getElementById('cancel-btn').addEventListener('click', resetForm);

// ---------- DELETE ----------
async function deleteMovie(doc) {
  if (!confirm('Delete "' + doc.title + '"?')) return;
  // remove() writes a tombstone (_deleted: true) which replicates to CouchDB
  await localDB.remove(doc._id, doc._rev);
  showMovies();
}

// ---------- Conflict resolution (optional helper) ----------
// Deletes the conflicting (losing) revisions so only the shown version remains.
async function resolveConflict(doc) {
  for (const rev of doc._conflicts) {
    await localDB.remove(doc._id, rev);
  }
  showMovies();
}

// ---------- REPLICATION ----------
// Two-way, continuous (live) sync with CouchDB. retry:true makes PouchDB
// keep retrying with backoff after going offline, so it resumes on reconnect.
let conflictCount = 0;   // number of docs with _conflicts (set in showMovies)
let lastStatus = ['Offline', 'offline'];

function setStatus(text, cls) {
  lastStatus = [text, cls];
  renderStatus();
}

// If any conflict exists, show a red "Conflict" status instead of Synced/Syncing
function renderStatus() {
  const [text, cls] = lastStatus;
  if (conflictCount > 0 && cls !== 'offline') {
    statusEl.textContent = 'Conflict';
    statusEl.className = 'conflict-status';
  } else {
    statusEl.textContent = text;
    statusEl.className = cls;
  }
}

function startSync() {
  const remoteDB = new PouchDB(COUCHDB_URL);
  localDB.sync(remoteDB, { live: true, retry: true })
    .on('active', () => setStatus('Syncing', 'syncing'))          // replication running / resumed
    .on('change', () => showMovies())                              // docs arrived from CouchDB (may include conflicts)
    .on('paused', (err) => {
      // paused without error = up to date; paused with error = remote unreachable (offline)
      if (err) setStatus('Offline', 'offline');
      else setStatus('Online/Synced', 'synced');
      showMovies();
    })
    .on('denied', (err) => console.error('Sync denied', err))
    .on('error', (err) => { console.error('Sync error', err); setStatus('Offline', 'offline'); });
}

// Browser offline/online events give faster feedback
window.addEventListener('offline', () => setStatus('Offline', 'offline'));

startSync();
showMovies();
