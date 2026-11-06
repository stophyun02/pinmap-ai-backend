import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(file){
  process.umask(0o077);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const db=new Database(file);
  fs.chmodSync(file,0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS login_attempts (
      email TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_until INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_id TEXT, source_url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '', export_timestamp TEXT, export_fbid TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,source_url)
    );
    CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, complete INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_post ON assets(user_id,post_id);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, status TEXT NOT NULL,
      source_url TEXT NOT NULL, material_json TEXT NOT NULL, settings_json TEXT NOT NULL,
      result_json TEXT, coverage_json TEXT, evidence_json TEXT, media_text_json TEXT, usage_json TEXT,
      error_json TEXT, lease_until INTEGER, worker_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created_at);
  `);
  const postColumns=new Set(db.pragma('table_info(posts)').map(x=>x.name));
  if(postColumns.has('saved_at')&&!postColumns.has('export_timestamp'))db.exec('ALTER TABLE posts RENAME COLUMN saved_at TO export_timestamp');
  const jobColumns=new Set(db.pragma('table_info(jobs)').map(x=>x.name));
  if(!jobColumns.has('media_text_json'))db.exec('ALTER TABLE jobs ADD COLUMN media_text_json TEXT');
  return db;
}

export const now=()=>new Date().toISOString();
export const parseJson=(value,fallback=null)=>value?JSON.parse(value):fallback;
export function publicPost(row,assets=[]){return{id:row.id,external_id:row.external_id,source_url:row.source_url,title:row.title,caption:row.caption,export_timestamp:row.export_timestamp,export_fbid:row.export_fbid,created_at:row.created_at,assets:assets.map(({path,user_id,post_id,...a})=>a)};}
export function publicJob(row){return{id:row.id,post_id:row.post_id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,completed_at:row.completed_at,coverage:parseJson(row.coverage_json),evidence:parseJson(row.evidence_json,[]),media_text:parseJson(row.media_text_json),result:parseJson(row.result_json),usage:parseJson(row.usage_json),error:parseJson(row.error_json)};}
