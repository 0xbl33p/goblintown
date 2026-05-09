import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COUNTRY_IDENTITY_FILE = "country-identity.json";

interface CountryIdentityDisk {
  id: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

export interface CountryIdentity {
  id: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

export async function ensureCountryIdentity(root: string): Promise<CountryIdentity> {
  const path = countryIdentityPath(root);
  const existing = readCountryIdentity(root);
  if (existing) return existing;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const data: CountryIdentity = {
    id: randomUUID().slice(0, 12),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAt: new Date().toISOString(),
  };
  await mkdir(join(root, ".goblintown"), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return data;
}

export function readCountryIdentity(root: string): CountryIdentity | null {
  const path = countryIdentityPath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CountryIdentityDisk;
    if (
      typeof raw.id !== "string" ||
      typeof raw.publicKeyPem !== "string" ||
      typeof raw.privateKeyPem !== "string" ||
      typeof raw.createdAt !== "string"
    ) return null;
    return {
      id: raw.id.trim(),
      publicKeyPem: raw.publicKeyPem.trim(),
      privateKeyPem: raw.privateKeyPem.trim(),
      createdAt: raw.createdAt,
    };
  } catch {
    return null;
  }
}

export function countryIdentityPath(root: string): string {
  return join(root, ".goblintown", COUNTRY_IDENTITY_FILE);
}

export function signCountryPayload(privateKeyPem: string, payload: string): string {
  const sig = sign(null, Buffer.from(payload, "utf8"), privateKeyPem);
  return sig.toString("base64");
}

export function verifyCountryPayload(
  publicKeyPem: string,
  payload: string,
  signatureBase64: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
