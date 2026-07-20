/**
 * Google 인증 유틸 (Cloudflare Worker / Node 공용 — WebCrypto만 사용)
 * - Google ID 토큰(RS256) 검증 (JWKS 주입 가능)
 * - RS256 서명 유틸(signJwtRS256)은 테스트에서 검증용 ID 토큰을 발급하는 데 쓰인다.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------- base64url ---------- */
export function b64urlFromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesFromB64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- PEM(PKCS8) → CryptoKey ---------- */
function pemToBytes(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPrivateKeyPem(pem) {
  return crypto.subtle.importKey(
    'pkcs8', pemToBytes(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

/* ---------- JWT 서명 (RS256) ---------- */
export async function signJwtRS256(claims, privateKeyPem, kid) {
  const header = { alg: 'RS256', typ: 'JWT' };
  if (kid) header.kid = kid;
  const input =
    b64urlFromBytes(te.encode(JSON.stringify(header))) + '.' +
    b64urlFromBytes(te.encode(JSON.stringify(claims)));
  const key = await importPrivateKeyPem(privateKeyPem);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(input));
  return input + '.' + b64urlFromBytes(new Uint8Array(sig));
}

/* ---------- JWT 디코딩 ---------- */
export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  return {
    header: JSON.parse(td.decode(bytesFromB64url(parts[0]))),
    payload: JSON.parse(td.decode(bytesFromB64url(parts[1]))),
    signedInput: parts[0] + '.' + parts[1],
    signature: bytesFromB64url(parts[2])
  };
}

/* ---------- Google ID 토큰 검증 ----------
 * opts:
 *   clientId       — 기대 aud
 *   allowedDomain  — 허용 Workspace 도메인
 *   getJwk(kid)    — kid에 해당하는 JWK 반환 (async, 없으면 null)
 *   nowSec         — 테스트용 현재 시각 (선택)
 * 성공 시 payload 반환, 실패 시 Error(코드 문자열) throw.
 * err.status: 401(토큰 문제) / 403(도메인 불허)
 */
export async function verifyIdToken(token, opts) {
  const fail = function (code, status) {
    const e = new Error(code);
    e.status = status || 401;
    throw e;
  };

  let dec;
  try { dec = decodeJwt(token); } catch (_) { fail('malformed_token'); }
  const header = dec.header, payload = dec.payload;

  if (header.alg !== 'RS256') fail('bad_alg');

  const jwk = await opts.getJwk(header.kid);
  if (!jwk) fail('unknown_kid');

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, dec.signature, te.encode(dec.signedInput)
  );
  if (!valid) fail('bad_signature');

  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    fail('bad_iss');
  }
  if (payload.aud !== opts.clientId) fail('bad_aud');

  const now = opts.nowSec || Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) fail('expired');

  const domain = opts.allowedDomain;
  const emailOk = payload.email_verified === true &&
    typeof payload.email === 'string' &&
    payload.email.toLowerCase().endsWith('@' + String(domain).toLowerCase());
  if (payload.hd !== domain && !emailOk) fail('domain_not_allowed', 403);

  return payload;
}
