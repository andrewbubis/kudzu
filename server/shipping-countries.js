// Every country Stripe Checkout will accept as a shipping destination.
//
// `shipping_address_collection.allowed_countries` is a fixed enum, not a
// free-form country list. Passing a code Stripe doesn't recognise makes
// checkout.sessions.create throw, which would break buying entirely —
// so this list is copied verbatim from the enum in the Stripe Node SDK
// we pin (stripe@17.5.0, types/Checkout/Sessions.d.ts, AllowedCountry),
// rather than from a general ISO 3166 list.
//
// Not present, and deliberately so: Stripe omits sanctioned countries
// (Cuba, Iran, North Korea, Syria) and a handful of US territories that
// ship as domestic US anyway. 'ZZ' is Stripe's "unknown" placeholder and
// is dropped here — it isn't a place anyone lives.
//
// If you upgrade the stripe package, re-copy this from the new SDK's
// type definitions; Stripe adds countries over time (Sudan, for one,
// arrived in the 2025-01-27 API version).

const SHIPPING_COUNTRIES = [
  'AC', 'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AT',
  'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI',
  'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY',
  'BZ', 'CA', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO',
  'CR', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC',
  'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FO', 'FR', 'GA',
  'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ',
  'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID',
  'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB',
  'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD',
  'ME', 'MF', 'MG', 'MK', 'ML', 'MM', 'MN', 'MO', 'MQ', 'MR', 'MS', 'MT',
  'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NG', 'NI', 'NL',
  'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK',
  'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU',
  'RW', 'SA', 'SB', 'SC', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SZ', 'TA', 'TC', 'TD', 'TF',
  'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW',
  'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VN', 'VU',
  'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
];

// Where Kudzu will actually send an original at launch.
//
// The full list above is what Stripe would *accept*; this is what we
// offer. A one-of-a-kind painting posted to the other side of the world
// is a different proposition from one going to Ohio — customs forms,
// weeks in transit, and an artist asked to pack for a journey they can't
// picture. US and Canada are the two where a rate is predictable and a
// signature actually comes back.
//
// Everywhere else is not refused silently: the piece page says to write
// in, and those go one at a time, by hand, on purpose.
const SHIPPING_LAUNCH = ['US', 'CA'];

const canShipTo = (country) =>
  SHIPPING_LAUNCH.indexOf(String(country || '').toUpperCase()) !== -1;

module.exports = { SHIPPING_COUNTRIES, SHIPPING_LAUNCH, canShipTo };
