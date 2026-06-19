import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashing via Node's scrypt. Random salt per password, constant-time
// verification.

const KEYLEN = 64;
const PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1 };

// promisify drops the options overload's typing, so wrap it by hand
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(
  plain: string,
): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(plain, salt, KEYLEN, PARAMS)) as Buffer;
  return { hash: derived.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyPassword(
  plain: string,
  hash: string | null,
  salt: string | null,
): Promise<boolean> {
  if (!hash || !salt) {
    await dummyVerify();
    return false;
  }
  const saltBuf = Buffer.from(salt, 'base64');
  const expected = Buffer.from(hash, 'base64');
  const derived = (await scryptAsync(plain, saltBuf, KEYLEN, PARAMS)) as Buffer;
  // timingSafeEqual throws on a length mismatch
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// burn a similar amount of time on unknown-user logins so timing doesn't leak
// whether the user exists
export async function dummyVerify(): Promise<void> {
  const salt = randomBytes(16);
  await scryptAsync('dummy-password', salt, KEYLEN, PARAMS);
}
