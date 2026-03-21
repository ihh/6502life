/**
 * Ed25519 wallet using Web Crypto API + IndexedDB storage.
 * Generates a keypair on first load, persists it across sessions.
 */

const DB_NAME = '6502coin';
const DB_VERSION = 1;
const STORE_NAME = 'wallet';
const KEY_ID = 'primary';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate or load an Ed25519 keypair.
 * Returns { publicKeyHex, sign(data) }.
 *
 * Note: Ed25519 via Web Crypto requires Chrome 113+ / Safari 17+ / Firefox 128+.
 * Falls back to a dummy wallet if not supported.
 */
export async function initWallet() {
  try {
    const db = await openDB();
    let stored = await dbGet(db, KEY_ID);

    if (!stored) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        false, // not extractable (we export public key separately)
        ['sign', 'verify']
      );

      // Export public key for display
      const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);

      stored = {
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        publicKeyHex: bufToHex(pubRaw),
      };

      await dbPut(db, KEY_ID, stored);
    }

    return {
      publicKeyHex: stored.publicKeyHex,
      async sign(data) {
        const buf = typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data;
        const sig = await crypto.subtle.sign(
          { name: 'Ed25519' },
          stored.privateKey,
          buf
        );
        return bufToHex(sig);
      }
    };
  } catch (e) {
    console.warn('Ed25519 not supported, using dummy wallet:', e.message);
    const dummyHex = '0'.repeat(64);
    return {
      publicKeyHex: dummyHex,
      async sign() { return '0'.repeat(128); }
    };
  }
}
