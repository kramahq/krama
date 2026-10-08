import type { AgentCard } from '@a2a-js/sdk';
import { verifyAgentCardSignature } from '@a2a-js/sdk';
import type { JWK } from 'jose';

/**
 * Whether to trust a signed agent card, and with which keys. The signature check itself (JWS over the JCS-canonical card)
 * is the A2A SDK's; this only decides which public keys count. A card whose signature fails is always refused once keys
 * are known, so a tampered card is never used "because verification was optional".
 */
export interface CardTrust {
  /** Public keys by `kid`, as JWKs. These are the organisation's own decision of who may sign a card. */
  keys?: Record<string, JWK>;
  /**
   * Also accept a key fetched from the signature's `jku` (a JWKS URL). The URL must be on the agent's own origin or on the
   * egress allow-list, and is read through the same guarded fetch as the card. Off by default: a fetched key proves the
   * card matches whatever that host serves, not that the signer is someone you chose.
   */
  allowJku?: boolean;
  /** Refuse a card that carries no valid signature. Default false. */
  requireSigned?: boolean;
}

export type SignatureStatus = 'verified' | 'unsigned' | 'unverified';

export class CardSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardSignatureError';
  }
}

const JWKS_MAX_BYTES = 64 * 1024;

/**
 * Checks a card against the trust settings. Returns `verified` (a signature checked out), `unsigned` (none present and
 * none required) or `unverified` (signed, but no key is configured to check it). Throws `CardSignatureError` when a
 * signature is present and wrong, or when one is required and missing.
 */
export async function checkCard(
  card: AgentCard,
  trust: CardTrust | undefined,
  o: { fetchImpl: typeof fetch; allowedOrigins: ReadonlySet<string> },
): Promise<SignatureStatus> {
  const signed = (card.signatures?.length ?? 0) > 0;
  if (!signed) {
    if (trust?.requireSigned) throw new CardSignatureError('The agent card is not signed');
    return 'unsigned';
  }
  const haveKeys = Object.keys(trust?.keys ?? {}).length > 0;
  if (!haveKeys && !trust?.allowJku) {
    if (trust?.requireSigned)
      throw new CardSignatureError(
        'The agent card is signed but no key is configured to verify it',
      );
    return 'unverified';
  }
  const verify = verifyAgentCardSignature(async (kid, jku) => {
    const known = trust?.keys?.[kid];
    if (known) return known;
    if (!trust?.allowJku || !jku) throw new CardSignatureError(`No trusted key for kid "${kid}"`);
    let origin: string;
    try {
      const u = new URL(jku);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      origin = u.origin;
    } catch {
      throw new CardSignatureError('The signature names a key URL that is not valid');
    }
    if (!o.allowedOrigins.has(origin))
      throw new CardSignatureError(`The key URL's origin ${origin} is not allowed`);
    const res = await o.fetchImpl(jku, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new CardSignatureError(`The key URL answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > JWKS_MAX_BYTES) throw new CardSignatureError('The key set is too large');
    const keys = (JSON.parse(text) as { keys?: JWK[] }).keys ?? [];
    const key = keys.find((k) => k.kid === kid);
    if (!key) throw new CardSignatureError(`The key set has no key "${kid}"`);
    return key;
  });
  try {
    await verify(card);
  } catch (e) {
    throw new CardSignatureError(
      `The agent card's signature did not verify: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return 'verified';
}
