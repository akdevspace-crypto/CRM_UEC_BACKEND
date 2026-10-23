/**
 * Name resolution utility for legacy routes (Express)
 */

function isGenericName(name) {
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

function formatPhoneNumber(phone) {
  if (!phone) return null;
  const clean = String(phone).replace(/^whatsapp:/i, '').trim();
  if (clean.startsWith('ig_') || clean.startsWith('EMAIL_')) return null;
  return clean;
}

function resolveBestCustomerName(customer, lead, channel) {
  // 1. If Customer has a verified, non-generic name, that is top priority
  if (customer && customer.name && !isGenericName(customer.name)) {
    return customer.name.trim();
  }

  // 2. If linked Lead has a verified customerName, use it
  if (lead && lead.customerName && !isGenericName(lead.customerName)) {
    return lead.customerName.trim();
  }

  const channelUpper = String(channel || (customer && customer.platform) || '').toUpperCase();

  // 3. Instagram channel or Instagram customer
  if (channelUpper === 'INSTAGRAM') {
    if (customer && customer.instagramUsername && !isGenericName(customer.instagramUsername)) {
      const handle = customer.instagramUsername.trim().replace(/^@/, '');
      return `@${handle}`;
    }
    const igId =
      (customer && customer.platformUserId) ||
      (customer && customer.phone && customer.phone.startsWith('ig_')
        ? customer.phone.slice(3)
        : null);
    if (igId) {
      return `Instagram User (${igId.slice(-4)})`;
    }
  }

  // 4. WhatsApp or Phone-based channel
  const cleanPhone = formatPhoneNumber((customer && customer.phone) || (lead && lead.phoneNumber));
  if (cleanPhone) {
    if (
      customer &&
      customer.name &&
      customer.name.trim() !== 'WhatsApp User' &&
      !customer.name.startsWith('ig_') &&
      !isGenericName(customer.name)
    ) {
      return customer.name.trim();
    }
    return cleanPhone;
  }

  // 5. Email fallback
  if (channelUpper === 'EMAIL' || (customer && customer.email) || (lead && lead.email)) {
    const email = (customer && customer.email) || (lead && lead.email);
    if (email) {
      return email.split('@')[0];
    }
  }

  // 6. Final graceful fallback
  if (customer && customer.name && customer.name.trim()) {
    return customer.name.trim();
  }

  return 'Customer';
}

module.exports = {
  isGenericName,
  formatPhoneNumber,
  resolveBestCustomerName
};
