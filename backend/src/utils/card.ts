// backend/src/utils/card.ts
//
// PCI-minimal helpers for card handling. The server NEVER persists the
// full PAN or the CVC; we only keep last4 + brand + exp + name + zip.
//
// The CVC is required to satisfy card-not-present validation upstream
// (and to defend against typos), but is dropped the instant validation
// completes. These helpers also enforce that the card_number is well-
// formed (length + Luhn) and detect the brand from the prefix.

export type CardBrandName = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';

export function detectCardBrand(num: string): CardBrandName {
  const n = num.replace(/\D/g, '');
  if (/^4\d{12,18}$/.test(n)) return 'visa';
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(n)) return 'mastercard';
  if (/^3[47]\d{13}$/.test(n)) return 'amex';
  if (/^(6011|65|64[4-9]|622)\d+$/.test(n)) return 'discover';
  return 'unknown';
}

/** Luhn (mod-10) checksum. */
export function isValidLuhn(num: string): boolean {
  const n = num.replace(/\D/g, '');
  if (n.length < 13 || n.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Returns the last four digits of a card number, sanitized. */
export function last4(num: string): string {
  const n = num.replace(/\D/g, '');
  return n.slice(-4).padStart(4, '0');
}

/** Mask a card number to `•••• •••• •••• 1234` for logs and emails. */
export function maskCardNumber(num: string): string {
  const l4 = last4(num);
  return `•••• •••• •••• ${l4}`;
}

/** Strip non-digits. */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}