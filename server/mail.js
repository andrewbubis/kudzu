// Notifications to artists — sales, and collectors asking about work.
//
// Two things worth knowing:
//
//  · Nothing here is ever fatal. If RESEND_API_KEY is missing, or Resend
//    is having a bad day, we log it and carry on. A collector's enquiry
//    is already safely in the database by the time we try to send; losing
//    the notification must never lose the message, and a failed sale
//    email must never fail the sale.
//
//  · An artist's email is never exposed publicly, so these are the only
//    way they hear anything. That's also why the reply-to is set to the
//    collector — the artist hits reply and it just works, without either
//    of them being handed the other's address by the website.

const KEY = () => process.env.RESEND_API_KEY;
// The domain registered in Resend is kudzuarts.com — the `send`
// subdomain only carries the SPF and MX records Resend asks for, and is
// not itself a sending domain. Using it here got a 403 back:
// "The send.kudzuarts.com domain is not verified."
const FROM = () => process.env.MAIL_FROM || 'Kudzu Arts <notifications@kudzuarts.com>';
const BASE = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function isConfigured() { return !!KEY(); }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// House style: paper, a serif, and no marketing furniture. These are
// notes between people, not campaigns.
function wrap(title, bodyHtml, footNote) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f2ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ec;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:540px;background:#ffffff;border:1px solid #e2e2e2;">
        <tr><td style="padding:30px 30px 22px;font-family:Georgia,'Times New Roman',serif;color:#211c2a;">
          <p style="margin:0 0 22px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#5f5a2c;">Kudzu Arts</p>
          <h1 style="margin:0 0 18px;font-size:24px;font-weight:400;line-height:1.2;">${title}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 30px 28px;font-family:Georgia,serif;font-size:12px;color:#8a8072;">
          ${footNote || ''}
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

async function send({ to, subject, html, replyTo, text }) {
  if (!isConfigured()) {
    console.log('mail off (no RESEND_API_KEY) — would have sent:', subject, '→', to);
    return { sent: false, reason: 'not_configured' };
  }
  if (!to) {
    console.log('mail skipped — no address for:', subject);
    return { sent: false, reason: 'no_address' };
  }
  try {
    // `to` may be a list. That matters: putting two people in the same To
    // header is what makes a reply land in both inboxes, which is the
    // difference between two notifications and one conversation.
    const recipients = (Array.isArray(to) ? to : [to])
      .map((a) => String(a || '').trim())
      .filter(Boolean);
    if (!recipients.length) {
      console.log('mail skipped — no address for:', subject);
      return { sent: false, reason: 'no_address' };
    }

    const body = { from: FROM(), to: recipients, subject, html };
    if (text) body.text = text;
    if (replyTo) body.reply_to = replyTo;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('resend rejected:', res.status, detail.slice(0, 300));
      return { sent: false, reason: 'rejected' };
    }
    return { sent: true };
  } catch (err) {
    console.error('mail send failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

// Where to reach an artist. SMS is stored but not wired to a provider
// yet — say so in the log rather than pretending it went out.
function addressFor(artist) {
  if (!artist) return null;
  if (artist.notify_channel === 'sms') {
    console.log('artist prefers SMS but no texting provider is configured — falling back to email:',
      artist.email);
  }
  return artist.email || null;
}

// ── Someone asked about a piece ──────────────────────────────────────
async function inquiryReceived({ artist, from, message, workTitle }) {
  const about = workTitle ? `about ${workTitle}` : 'about your work';
  return send({
    to: addressFor(artist),
    subject: `${from.name} asked ${about}`,
    // Reply goes straight to the collector, not to us.
    replyTo: from.email,
    text: `${from.name} <${from.email}> wrote:\n\n${message}\n\nReply to this email to answer them directly.`,
    html: wrap(
      `${esc(from.name)} asked ${esc(about)}.`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         They left this message:</p>
       <div style="margin:0 0 20px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;
                   font-size:15px;line-height:1.6;color:#211c2a;white-space:pre-wrap;">${esc(message)}</div>
       <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
         Just hit reply — it goes straight to ${esc(from.name)} at
         <a href="mailto:${esc(from.email)}" style="color:#5f5a2c;">${esc(from.email)}</a>.
         They can't see your address unless you write back.</p>`,
      'Sent because someone used the contact form on your Kudzu Arts page.'
    )
  });
}

// ── A piece sold ─────────────────────────────────────────────────────
async function workSold({ artist, workTitle, amountCents, currency, isPickup }) {
  const money = amountCents == null ? null :
    new Intl.NumberFormat('en-US', {
      style: 'currency', currency: (currency || 'usd').toUpperCase(),
      maximumFractionDigits: 0
    }).format(amountCents / 100);

  const title = workTitle ? `${workTitle} sold.` : 'One of your works sold.';
  const profile = BASE() ? `${BASE()}/workinprogress/sales.html` : null;

  return send({
    to: addressFor(artist),
    subject: workTitle ? `${workTitle} sold` : 'Your work sold',
    text: isPickup
      ? `${title}${money ? ' ' + money : ''}\n\nYou've been paid in full already. ` +
        `This one is a local pickup.\n\n` +
        `A separate email has just gone to you and the buyer together, with each other's ` +
        `details on it — reply to all on that one and you're talking to them. It's on the ` +
        `buyer to get in touch and plan when they're coming; you say where you'd like to meet.\n\n` +
        `When they arrive, open Sales on your phone and tap Hand it over. You both sign the ` +
        `bill of lading, and that completes the sale.`
      : `${title}${money ? ' ' + money : ''}\n\nYou've been paid — your payout is on its way from Stripe. ` +
        `Check your Kudzu sales page for the buyer's shipping address, and post it with the ` +
        `packed weight and box size you recorded.`,
    html: wrap(
      esc(title),
      `${money ? `<p style="margin:0 0 16px;font-size:26px;color:#211c2a;">${esc(money)}</p>` : ''}
       ${isPickup
         ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
              You've been paid in full already. This one is a <b>local pickup</b>.</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
              A second email has just gone out to you and the buyer <b>together</b>, with
              each other's details on it — reply to all on that one and you're talking to
              them. It's on the buyer to get in touch and plan when they're coming. You say
              where you'd like to meet; your address is never published by Kudzu.</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#544c5e;">
              When they arrive, open <b>Sales</b> on your phone and tap <b>Hand it over</b>.
              You sign, hand them your phone, they sign — and that bill of lading completes
              the sale and goes to you both as the receipt.</p>`
         : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
              You've been paid — your share is already on its way to your bank through Stripe.</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#544c5e;">
              Next: the buyer's shipping address is on your sales page. Pack it to the weight and box size
              you recorded when you uploaded it, and send it off. Ship signature-required.</p>`}
       ${profile ? `<p style="margin:0;"><a href="${esc(profile)}"
          style="display:inline-block;padding:12px 22px;background:#8a8f43;color:#ffffff;
                 text-decoration:none;font-size:14px;">See the order</a></p>` : ''}`,
      'Sent because a work on your Kudzu Arts page sold.'
    )
  });
}

// ── The introduction ─────────────────────────────────────────────────
// A local pickup is two strangers who need to meet, and until this email
// exists neither of them has any way to reach the other. So: one message,
// both of them in the To line, each other's address visible in the header.
// Reply-all and it's a conversation.
//
// It assigns the first move to the buyer, by name. Somebody has to go
// first, and left unassigned both of them wait on the other.
async function pickupIntroduction({ bol, artist, artistEmail }) {
  const money = bol.price_cents == null ? '' :
    new Intl.NumberFormat('en-US', {
      style: 'currency', currency: (bol.currency || 'usd').toUpperCase(),
      maximumFractionDigits: 0
    }).format(bol.price_cents / 100);

  const artistName = artist && artist.name ? artist.name : 'the artist';
  const to = addressFor(artist) || artistEmail;
  const city = bol.pickup_city || '';
  const where = city ? ` in ${city}` : '';

  // Both addresses in To. Reply-to matches, so plain Reply reaches
  // everyone even in clients that treat Reply-all as an advanced move.
  const both = [bol.buyer_email, to].filter(Boolean);

  const person = (label, name, email, phone) =>
    `<td valign="top" style="padding:0 10px 0 0;font-family:Georgia,serif;">
       <p style="margin:0 0 3px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8072;">${esc(label)}</p>
       <p style="margin:0 0 2px;font-size:16px;color:#211c2a;">${esc(name)}</p>
       ${email ? `<p style="margin:0;font-size:14px;"><a href="mailto:${esc(email)}" style="color:#5f5a2c;">${esc(email)}</a></p>` : ''}
       ${phone ? `<p style="margin:0;font-size:14px;"><a href="tel:${esc(phone)}" style="color:#5f5a2c;">${esc(phone)}</a></p>` : ''}
     </td>`;

  return send({
    to: both,
    replyTo: both,
    subject: `${bol.work_title} — arranging pickup${city ? ' in ' + city : ''}`,
    text:
      `${bol.buyer_name} has bought ${bol.work_title} from ${artistName}${where}` +
      `${money ? ' for ' + money : ''}. Thank you, both.\n\n` +
      `You're both on this email. Reply to all and you're talking to each other.\n\n` +
      `From here it's on ${bol.buyer_name} to get in touch with ${artistName} and plan ` +
      `when you'll come${city ? ' to ' + city : ''} to meet them.\n\n` +
      `${bol.buyer_name} — ${bol.buyer_email}${bol.buyer_phone ? ' · ' + bol.buyer_phone : ''}\n` +
      `${artistName} — ${to}\n\n` +
      `${bol.buyer_name}: reach out and settle when and where the two of you will make ` +
      `the exchange. ${artistName} knows the city and will say where.\n\n` +
      `${artistName}: you've already been paid in full. When ${bol.buyer_name} arrives, ` +
      `open your profile, go to Sales on your phone and tap Hand it over. You both sign ` +
      `the bill of lading — that document is what completes the sale and stands as the ` +
      `receipt for it. It's emailed to you both the moment it's signed.`,
    html: wrap(
      `Arranging pickup for <span style="font-style:italic;">${esc(bol.work_title)}</span>.`,
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#544c5e;">
         ${esc(bol.buyer_name)} has bought <b>${esc(bol.work_title)}</b> from
         ${esc(artistName)}${esc(where)}${money ? ' for ' + esc(money) : ''}. Thank you, both.</p>

       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         You're both on this email — <b>reply to all and you're talking to each other</b>.
         From here it's on ${esc(bol.buyer_name)} to get in touch with ${esc(artistName)}
         and plan when to come${city ? ' to ' + esc(city) : ''} and meet them.</p>

       <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="margin:0 0 22px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;">
         <tr>
           ${person('Buyer', bol.buyer_name, bol.buyer_email, bol.buyer_phone)}
           ${person('Artist', artistName, to, null)}
         </tr>
       </table>

       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         <b>${esc(bol.buyer_name)}</b> — reach out and settle when and where the two of you
         will make the exchange. ${esc(artistName)} knows
         ${city ? esc(city) : 'their city'} and will say where to meet.</p>

       <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#544c5e;">
         <b>${esc(artistName)}</b> — you've already been paid in full. When
         ${esc(bol.buyer_name)} arrives, open your profile, go to <b>Sales</b> on your phone
         and tap <b>Hand it over</b>.</p>

       <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5f5a2c;">Signing for it</p>
       <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
         You both sign the <b>bill of lading</b> — ${esc(artistName)} signs, hands the phone
         across, ${esc(bol.buyer_name)} signs. That document is what completes the sale in
         full and stands as the receipt for it. It's emailed to you both the moment it's
         signed, and it's what answers any question later about what changed hands and
         when.</p>`,
      'Sent to both of you because this was a local pickup on Kudzu Arts. ' +
      'Replies go to everyone on this message.'
    )
  });
}

// ── The handoff is signed ────────────────────────────────────────────
// Goes to both parties the moment the second signature lands. This is
// the receipt — for the buyer it's proof of what they bought and from
// whom, and for the artist it's the document that answers a chargeback
// months later. Both get the same text, so neither can be told a
// different story about what was agreed.
function bolBlock(b, money) {
  const line = (k, v) => v
    ? `<tr><td style="padding:5px 0;color:#8a8072;font-size:13px;width:38%;">${esc(k)}</td>
         <td style="padding:5px 0;color:#211c2a;font-size:14px;">${esc(v)}</td></tr>`
    : '';
  const at = (iso) => new Date(iso).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="margin:0 0 20px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;">
      ${line('Work', b.work_title)}
      ${line('Details', b.work_details)}
      ${line('Price', money)}
      ${line('Condition', b.condition)}
      ${line('Artist', b.artist_name)}
      ${line('Buyer', b.buyer_name)}
      ${line('Artist signed', b.artist_signed_at ? at(b.artist_signed_at) : null)}
      ${line('Buyer signed', b.buyer_signed_at ? at(b.buyer_signed_at) : null)}
      ${line('Reference', String(b.id).slice(0, 8).toUpperCase())}
    </table>`;
}

async function handoffSigned({ bol, artistEmail }) {
  const money = bol.price_cents == null ? '' :
    new Intl.NumberFormat('en-US', {
      style: 'currency', currency: (bol.currency || 'usd').toUpperCase(),
      maximumFractionDigits: 0
    }).format(bol.price_cents / 100);

  const details = bolBlock(bol, money);
  const docUrl = BASE() ? `${BASE()}/workinprogress/bol.html?id=${bol.id}` : null;
  const ref = String(bol.id).slice(0, 8).toUpperCase();
  const proof =
    `<p style="margin:0;font-size:13px;line-height:1.6;color:#8a8072;">
       Signed electronically by both parties and recorded with a timestamp. Keep this email —
       it is the record that this work changed hands.</p>`;

  // The buyer has no account here, so this email is the only copy they
  // will ever have. It has to stand on its own.
  const toBuyer = send({
    to: bol.buyer_email,
    subject: `Receipt — ${bol.work_title}`,
    text: `You received ${bol.work_title} from ${bol.artist_name}. ${money}\n\n` +
          `Reference ${ref}. Signed by both parties. Copyright remains with the artist.`,
    html: wrap(
      `You received <span style="font-style:italic;">${esc(bol.work_title)}</span>.`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Thank you — and congratulations. Here is your receipt.</p>
       ${details}
       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Title to the work is yours. Copyright and reproduction rights stay with the
         artist, as they do with any original artwork.</p>
       ${proof}`,
      'Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com'
    )
  });

  const toArtist = send({
    to: artistEmail,
    subject: `Signed — ${bol.work_title} handed over`,
    text: `${bol.buyer_name} signed for ${bol.work_title}. ${money}\n\n` +
          `Keep this as your proof of delivery. Reference ${ref}.`,
    html: wrap(
      `${esc(bol.buyer_name)} signed for it.`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         The handoff is recorded. Your share was paid at the time of purchase — nothing further to do.</p>
       ${details}
       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Keep this. If a buyer ever disputes a charge, a signed record of delivery is
         what settles it — and this is that record.</p>
       ${docUrl ? `<p style="margin:0 0 18px;"><a href="${esc(docUrl)}"
          style="display:inline-block;padding:12px 22px;background:#8a8f43;color:#ffffff;
                 text-decoration:none;font-size:14px;">View the document</a></p>` : ''}
       ${proof}`,
      'Also saved under Documents in your Kudzu Arts account.'
    )
  });

  return Promise.all([toBuyer, toArtist]);
}

module.exports = {
  isConfigured, send, inquiryReceived, workSold, pickupIntroduction, handoffSigned
};
