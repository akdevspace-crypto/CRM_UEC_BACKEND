/**
 * Omnichannel Contact Name Resolution Utility
 * 
 * Accurately determines the best verified customer name across
 * WhatsApp, Instagram, Email, and Voice channels according to
 * the CRM's verified customer data, lead context, and provider profile info.
 * Prevents generic placeholders ("Instagram Contact", "WhatsApp User")
 * and prevents overwriting verified names.
 */

export function isGenericName(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'unknown caller' ||
    lower === 'instagram contact' ||
    lower === 'instagram user' ||
    lower === 'whatsapp user' ||
    lower === 'messenger user' ||
    lower === 'customer' ||
    lower.startsWith('customer ') ||
    lower.startsWith('ig_') ||
    lower.startsWith('user ') ||
    lower.startsWith('ticket client')
  ) {
    return true;
  }

  // Pure phone number as a name
  if (/^\+?\d{8,15}$/.test(trimmed)) {
    return true;
  }

  return false;
}

export function formatPhoneNumber(phone?: string | null): string | null {
  if (!phone) return null;
  const clean = String(phone).replace(/^whatsapp:/i, '').trim();
  if (clean.startsWith('ig_') || clean.startsWith('EMAIL_')) return null;
  return clean;
}

export interface CustomerNameResolutionInput {
  customer?: {
    id?: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    platform?: string | null;
    platformUserId?: string | null;
    instagramUsername?: string | null;
  } | null;
  lead?: {
    id?: string;
    customerName?: string | null;
    phoneNumber?: string | null;
    email?: string | null;
  } | null;
  channel?: string | null;
}

export function resolveBestCustomerName(
  customer?: CustomerNameResolutionInput['customer'],
  lead?: CustomerNameResolutionInput['lead'],
  channel?: string | null,
): string {
  // 1. If Customer has a verified, non-generic name, that is top priority
  if (customer?.name && !isGenericName(customer.name)) {
    return customer.name.trim();
  }

  // 2. If linked Lead has a verified customerName, use it
  if (lead?.customerName && !isGenericName(lead.customerName)) {
    return lead.customerName.trim();
  }

  const channelUpper = (channel || customer?.platform || '').toUpperCase();

  // 3. Instagram channel or Instagram customer
  if (channelUpper === 'INSTAGRAM') {
    if (customer?.instagramUsername && !isGenericName(customer.instagramUsername)) {
      const handle = customer.instagramUsername.trim().replace(/^@/, '');
      return `@${handle}`;
    }
    const igId =
      customer?.platformUserId ||
      (customer?.phone && customer.phone.startsWith('ig_')
        ? customer.phone.slice(3)
        : null);
    if (igId) {
      return `Instagram User (${igId.slice(-4)})`;
    }
  }

  // 4. WhatsApp or Phone-based channel: clean phone number
  const cleanPhone = formatPhoneNumber(customer?.phone || lead?.phoneNumber);
  if (cleanPhone) {
    // If customer has a ProfileName that was stored and isn't generic
    if (
      customer?.name &&
      customer.name.trim() !== 'WhatsApp User' &&
      !customer.name.startsWith('ig_') &&
      !isGenericName(customer.name)
    ) {
      return customer.name.trim();
    }
    return cleanPhone;
  }

  // 5. Email fallback
  if (channelUpper === 'EMAIL' || customer?.email || lead?.email) {
    const email = customer?.email || lead?.email;
    if (email) {
      return email.split('@')[0];
    }
  }

  // 6. Final graceful fallback
  if (customer?.name && customer.name.trim()) {
    return customer.name.trim();
  }

  return 'Customer';
}
