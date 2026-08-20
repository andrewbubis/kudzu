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

// ── ...and the collector hears back ──────────────────────────────────
// Sending a message into a form and getting nothing back is indisputably
// worse than getting a slow reply. This costs nothing and closes the loop.
async function inquiryAcknowledged({ to, name, artistName, workTitle }) {
  const about = workTitle ? `about ${workTitle}` : `about ${artistName}'s work`;
  return send({
    to,
    subject: `Your message to ${artistName}`,
    text:
      `Thanks ${name} — your message ${about} went straight to ${artistName}.\n\n` +
      `They'll reply to you directly, from their own address. Artists answer their own ` +
      `messages here, so give them a few days.\n\n` +
      `If you don't hear anything, write to info@kudzuarts.com and we'll chase it.`,
    html: wrap(
      `Your message reached ${esc(artistName)}.`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Thanks, ${esc(name)} — what you wrote ${esc(about)} went straight to
         ${esc(artistName)}, and they'll reply to you directly from their own address.</p>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Artists answer their own messages here — there's no gallery desk in between — so
         give them a few days.</p>
       <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
         Heard nothing? Write to
         <a href="mailto:info@kudzuarts.com" style="color:#5f5a2c;">info@kudzuarts.com</a>
         and we'll chase it for you.</p>`,
      'Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com'
    )
  });
}

// ── A piece sold ─────────────────────────────────────────────────────
async function workSold({ artist, workTitle, amountCents, currency, isPickup, order }) {
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
        `When they arrive, open Sales on your phone and tap Complete the sale. You both sign ` +
        `the bill of lading, and that's what finishes it.`
      : `${title}${money ? ' ' + money : ''}\n\nYou've been paid — your payout is on its way from Stripe.\n\n` +
        (order && order.ship_by
          ? `Post it by ${longDate(order.ship_by)}. The buyer has been told that date.\n\n` : '') +
        (order && addressLines(order).length
          ? `Ship to:\n${addressLines(order).join('\n')}\n\n` : '') +
        `Pack it to the weight and box size you recorded, insured, signature required. ` +
        `Then open Sales and enter the tracking number — that's what tells the buyer it's ` +
        `on its way, and it's what protects you if they ever dispute the charge.`,
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
              When they arrive, open <b>Sales</b> on your phone and tap <b>Complete the sale</b>.
              You sign, hand them your phone, they sign — and that bill of lading is what
              finishes it. It goes to you both as the receipt.</p>`
         : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
              You've been paid — your share is already on its way to your bank through Stripe.</p>

            ${order && order.ship_by ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="margin:0 0 18px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;">
              <tr><td style="font-family:Georgia,serif;">
                <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8072;">Post it by</p>
                <p style="margin:0 0 4px;font-size:19px;color:#211c2a;">${esc(longDate(order.ship_by))}</p>
                <p style="margin:0;font-size:13px;color:#8a8072;">The buyer has been given this date.</p>
              </td></tr>
            </table>` : ''}

            ${order && addressLines(order).length ? `<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5f5a2c;">Ship to</p>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#211c2a;">
              ${addressLines(order).map(esc).join('<br>')}</p>` : ''}

            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#544c5e;">
              Pack it to the weight and box size you recorded, insured, signature required.
              Then open <b>Sales</b> and enter the tracking number — that's what tells the
              buyer it's on its way, and it's what protects you if they ever dispute the
              charge.</p>`}
       ${profile ? `<p style="margin:0;"><a href="${esc(profile)}"
          style="display:inline-block;padding:12px 22px;background:#8a8f43;color:#ffffff;
                 text-decoration:none;font-size:14px;">See the order</a></p>` : ''}`,
      'Sent because a work on your Kudzu Arts page sold.'
    )
  });
}

// ── The buyer's order confirmation ───────────────────────────────────
// Kudzu used to send a shipping buyer nothing at all. They paid, got
// bounced to the gallery, and received one line from Stripe describing a
// card charge. Then a month of silence while an artist crated a painting.
//
// That silence is where chargebacks come from. Not fraud — a person who
// spent real money, heard nothing, and concluded something went wrong.
// So this says what was bought, when it will be posted, and what happens
// next, in that order.
function money0(cents, currency) {
  if (cents == null) return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: (currency || 'usd').toUpperCase(),
      maximumFractionDigits: 0
    }).format(cents / 100);
  } catch (e) { return '$' + Math.round(cents / 100); }
}

const longDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
  { weekday: 'long', month: 'long', day: 'numeric' });

function addressLines(o) {
  return [o.ship_name, o.ship_line1, o.ship_line2,
    [o.ship_city, o.ship_state].filter(Boolean).join(', '),
    o.ship_postal, o.ship_country].filter(Boolean);
}

async function orderConfirmation({ order, artistName }) {
  const price = money0(order.price_cents, order.currency);
  const by = order.ship_by ? longDate(order.ship_by) : null;

  return send({
    to: order.buyer_email,
    subject: `Your order — ${order.work_title}`,
    text:
      `Thank you. You've bought ${order.work_title}` +
      `${artistName ? ' by ' + artistName : ''}${price ? ', ' + price : ''}.\n\n` +
      (by
        ? `${artistName || 'The artist'} will pack and post it by ${by}. Original work is ` +
          `packed by the artist who made it, not pulled off a shelf, so it takes a little ` +
          `longer than a warehouse would.\n\n` +
          `You'll get an email with a tracking number the day it goes out. It ships ` +
          `insured and needs a signature, so plan to be there — or have it sent somewhere ` +
          `you will be.\n\n`
        : '') +
      (addressLines(order).length ? `Going to:\n${addressLines(order).join('\n')}\n\n` : '') +
      `Questions about this order: info@kudzuarts.com`,
    html: wrap(
      `Thank you.`,
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#544c5e;">
         You've bought <b>${esc(order.work_title)}</b>${artistName ? ' by ' + esc(artistName) : ''}${
           order.work_details ? ' — ' + esc(order.work_details) : ''}.</p>
       ${price ? `<p style="margin:0 0 20px;font-size:26px;color:#211c2a;">${esc(price)}</p>` : ''}

       ${by ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="margin:0 0 20px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;">
         <tr><td style="font-family:Georgia,serif;">
           <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8072;">Posted by</p>
           <p style="margin:0;font-size:19px;color:#211c2a;">${esc(by)}</p>
         </td></tr>
       </table>

       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         Original work is packed by the artist who made it rather than pulled off a shelf,
         so it takes longer than a warehouse would. ${esc(artistName || 'The artist')} has
         until then to get it into the post.</p>

       <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#544c5e;">
         You'll get an email with a <b>tracking number</b> the day it goes out. It travels
         insured and needs a signature on delivery — so plan to be there, or tell us
         somewhere you will be.</p>` : ''}

       ${addressLines(order).length ? `<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5f5a2c;">Going to</p>
       <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#211c2a;">
         ${addressLines(order).map(esc).join('<br>')}</p>
       <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#8a8072;">
         Wrong address, or need it somewhere else? Reply to this email today and we'll
         change it before it's packed.</p>` : ''}

       <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
         Anything else — <a href="mailto:info@kudzuarts.com" style="color:#5f5a2c;">info@kudzuarts.com</a>.</p>`,
      'Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com'
    )
  });
}

// ── It's in the post ─────────────────────────────────────────────────
async function orderShipped({ order, artistName }) {
  const carrier = order.carrier ? order.carrier : 'the carrier';
  return send({
    to: order.buyer_email,
    subject: `On its way — ${order.work_title}`,
    text:
      `${order.work_title} is in the post.\n\n` +
      `Tracking: ${order.tracking}${order.carrier ? ' (' + order.carrier + ')' : ''}\n\n` +
      `It's insured and needs a signature on delivery. If nobody's home ${carrier} will ` +
      `leave a card rather than the work.\n\n` +
      `If it arrives damaged, photograph the box before you open it any further and email ` +
      `info@kudzuarts.com the same day. That photograph is what settles a claim.`,
    html: wrap(
      `<span style="font-style:italic;">${esc(order.work_title)}</span> is on its way.`,
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#544c5e;">
         ${esc(artistName || 'The artist')} packed and posted it${order.carrier ? ' with ' + esc(order.carrier) : ''}.</p>

       <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="margin:0 0 20px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;">
         <tr><td style="font-family:Georgia,serif;">
           <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8072;">Tracking</p>
           <p style="margin:0;font-size:19px;color:#211c2a;letter-spacing:0.03em;">${esc(order.tracking)}</p>
         </td></tr>
       </table>

       <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
         It's insured, and it needs a <b>signature on delivery</b> — if nobody's home,
         ${esc(carrier)} will leave a card rather than the work.</p>

       <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
         If it turns up damaged: <b>photograph the box before you open it any further</b>
         and email <a href="mailto:info@kudzuarts.com" style="color:#5f5a2c;">info@kudzuarts.com</a>
         the same day. That photograph is what settles a claim — without it, a carrier will
         say it left them in good condition.</p>`,
      'Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com'
    )
  });
}

// ── A sale came undone ───────────────────────────────────────────────
// Nobody enjoys this email, which is exactly why it has to exist. Before
// it, a refund or a chargeback was silent: the artist's first clue would
// be money missing from their bank weeks later, with no explanation and
// nobody to ask.
//
// The two cases are genuinely different and the email says so. A refund
// is over. A dispute is a thing that can still be won — and it is won on
// evidence, which the artist has if they entered a tracking number or
// signed a bill of lading. So this tells them to send it in.
async function saleReversed({ artist, order, kind }) {
  const price = money0(order.price_cents, order.currency);
  const refunded = kind === 'refunded';

  const evidence = order.tracking
    ? `You have tracking on this one — ${order.tracking}${order.carrier ? ' with ' + order.carrier : ''}. ` +
      `That, plus the signature on delivery, is strong evidence.`
    : order.delivery === 'pickup'
      ? `This was a local pickup. If you both signed the bill of lading, that document — ` +
        `with both signatures and their timestamps — is your evidence.`
      : `There's no tracking number recorded against this order, which makes it much ` +
        `harder to answer. Send us anything you have: a receipt from the carrier, ` +
        `photographs of it packed, messages with the buyer.`;

  return send({
    to: addressFor(artist),
    subject: refunded
      ? `Refunded — ${order.work_title}`
      : `Payment disputed — ${order.work_title}`,
    text: refunded
      ? `The sale of ${order.work_title}${price ? ' (' + price + ')' : ''} has been refunded, ` +
        `and the money has gone back to the buyer.\n\n` +
        `The piece is back on your page and available again — you don't need to re-publish it.\n\n` +
        `Questions: info@kudzuarts.com`
      : `The buyer of ${order.work_title}${price ? ' (' + price + ')' : ''} has disputed the ` +
        `charge with their bank. The money is held while it's decided.\n\n` +
        `This is not settled, and disputes are won on evidence.\n\n${evidence}\n\n` +
        `Email info@kudzuarts.com and we'll put the response together. There's a deadline, ` +
        `so don't sit on it. The piece stays marked sold in the meantime.`,
    html: wrap(
      refunded
        ? `<span style="font-style:italic;">${esc(order.work_title)}</span> was refunded.`
        : `The payment for <span style="font-style:italic;">${esc(order.work_title)}</span> is being disputed.`,
      refunded
        ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
             ${price ? esc(price) + ' has' : 'The money has'} gone back to the buyer.</p>
           <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
             The piece is <b>back on your page and available again</b> — you don't need to
             re-publish it or do anything at all.</p>
           <p style="margin:0;font-size:15px;line-height:1.6;color:#544c5e;">
             If this is a surprise, tell us:
             <a href="mailto:info@kudzuarts.com" style="color:#5f5a2c;">info@kudzuarts.com</a>.</p>`
        : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
             ${esc(order.buyer_name)} has disputed the charge with their bank.
             ${price ? esc(price) + ' is' : 'The money is'} held while it's decided.</p>
           <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
             <b>This isn't settled.</b> Disputes are won on evidence, and they're won often.</p>
           <div style="margin:0 0 18px;padding:16px 18px;background:#f4f2ec;border-left:2px solid #8a8f43;
                       font-size:14.5px;line-height:1.6;color:#211c2a;">${esc(evidence)}</div>
           <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#544c5e;">
             Email <a href="mailto:info@kudzuarts.com" style="color:#5f5a2c;">info@kudzuarts.com</a>
             and we'll put the response together with you. There's a deadline on these, so
             don't leave it.</p>
           <p style="margin:0;font-size:14px;line-height:1.6;color:#8a8072;">
             The piece stays marked sold while this is argued — it may well still be in the
             buyer's hands, and relisting it now would be worse than waiting.</p>`,
      'Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com'
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
      `open your profile, go to Sales on your phone and tap Complete the sale. You both sign ` +
      `the bill of lading — that document is what completes the sale in full and stands as ` +
      `the receipt for it. It's emailed to you both the moment it's signed.`,
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
         and tap <b>Complete the sale</b>.</p>

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
  isConfigured, send,
  inquiryReceived, inquiryAcknowledged,
  workSold, orderConfirmation, orderShipped, saleReversed,
  pickupIntroduction, handoffSigned
};
