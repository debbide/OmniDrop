import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(
      "OMNIDROP_DATA_KEY must be a base64-encoded 32-byte key (AES-256)",
    );
  }
  return key;
}

export function encryptJson(
  dataKeyB64: string,
  value: unknown,
  keyVersion = 1,
): EncryptedPayload {
  const key = decodeKey(dataKeyB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion,
  };
}

export function decryptJson<T = unknown>(
  dataKeyB64: string,
  payload: Pick<EncryptedPayload, "ciphertext" | "iv" | "authTag">,
): T {
  const key = decodeKey(dataKeyB64);
  const decipher = createDecipheriv(
    ALGO,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export function requireDataKey(envValue: string | undefined): string {
  if (!envValue || !envValue.trim()) {
    throw new Error(
      "Missing OMNIDROP_DATA_KEY. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  // Validate length early
  decodeKey(envValue.trim());
  return envValue.trim();
}
