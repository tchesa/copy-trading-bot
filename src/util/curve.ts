import { ed25519 } from "@noble/curves/ed25519";
import { base58Decode } from "./base58.js";

const cache = new Map<string, boolean>();

/**
 * True if the address is a point on ed25519, i.e. it can be a keypair wallet.
 * Program-derived addresses (pools, bonding curves, vault authorities) are off-curve.
 */
export function isOnCurve(address: string): boolean {
  const hit = cache.get(address);
  if (hit !== undefined) return hit;
  let ok: boolean;
  try {
    const b = base58Decode(address);
    if (b.length !== 32) ok = false;
    else {
      ed25519.ExtendedPoint.fromHex(b);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (cache.size > 500_000) cache.clear();
  cache.set(address, ok);
  return ok;
}
