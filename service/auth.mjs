import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {AppError} from '../lib/errors.mjs';
import {now} from './db.mjs';

const scrypt=promisify(crypto.scrypt);
const DURATION=30*24*60*60*1000;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
export function normalizeEmail(value){if(typeof value!=='string')throw new AppError('이메일을 입력하세요.',{status:400});const email=value.trim().toLowerCase();if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError('이메일 형식이 올바르지 않습니다.',{status:400});return email;}
export async function hashPassword(password){if(typeof password!=='string'||password.length<12||password.length>1024)throw new AppError('비밀번호는 12자 이상으로 입력하세요.',{status:400});const salt=crypto.randomBytes(16);const key=await scrypt(password,salt,64,{N:16384,r:8,p:1});return `scrypt:16384:8:1:${salt.toString('hex')}:${key.toString('hex')}`;}
export async function verifyPassword(password,encoded){if(typeof password!=='string'||password.length>1024)return false;const [method,n,r,p,salt,expected]=encoded.split(':');if(method!=='scrypt')return false;const key=await scrypt(password,Buffer.from(salt,'hex'),64,{N:Number(n),r:Number(r),p:Number(p)});return equal(key.toString('hex'),expected);}
export function newSession(db,userId){const token=crypto.randomBytes(32).toString('base64url'),expires=Date.now()+DURATION;db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(digest(token),userId,expires,now());return{token,expires};}
export function sessionUser(db,req){const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pinmap_session='));if(!cookie)return null;const token=cookie.slice('pinmap_session='.length);if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;return db.prepare('SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token),Date.now())||null;}
export function logout(db,req){const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pinmap_session='));if(cookie)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(cookie.slice('pinmap_session='.length)));}
export function sessionCookie(token,secure){return `pinmap_session=${token}; HttpOnly; ${secure?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=${DURATION/1000}`;}
export function clearCookie(secure){return `pinmap_session=; HttpOnly; ${secure?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=0`;}
