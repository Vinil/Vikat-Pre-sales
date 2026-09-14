/**
 * imageGen.js — the banner on a LinkedIn post.
 *
 * A post without a picture is a post nobody stops scrolling for, and neither a
 * browser nor a Worker can produce a photograph. So this asks a model for one.
 *
 * It asks for the BACKGROUND ONLY, and that is the whole design. Image models
 * garble set text: ask for a headline inside the picture and it comes back as
 * confident gibberish that looks fine in a thumbnail and is unusable at full
 * size. The headline, the wordmark and the URL are drawn over the image
 * afterwards, where they are typography rather than a generated guess, and
 * where they are on brand by construction. The model does the half it is good
 * at and nothing else.
 *
 * generateImage() is the only thing the rest of the Worker knows about, in the
 * same way storage.js hides KV and deliverLead() hides the sink. The provider
 * is one branch inside it: swapping gpt-image-1 for something else, or turning
 * images off, changes this file alone.
 */

/** How long a month has left, for the budget counter's TTL. */
function monthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function secondsLeftInMonth(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * How many images the month's budget buys.
 *
 * Dollars are what was agreed and images are what KV can count, so the budget
 * is divided by an estimated unit cost. The estimate is config, and the note
 * on it in config.js says plainly that it is an estimate.
 */
export function monthlyAllowance(cfg) {
  const cost = Number(cfg.IMAGE_COST_USD) || 0;
  if (cost <= 0) return 0;
  return Math.max(0, Math.floor(Number(cfg.IMAGE_MONTHLY_BUDGET_USD || 0) / cost));
}

/**
 * A photographic brief, with the things a model gets wrong ruled out.
 *
 * The model is told not to render text because it cannot, and told the frame
 * leaves room on the left because that is where the headline goes. Everything
 * else is the model's own brief, unedited: this is a scene description written
 * by the assistant that knows the campaign, and rewriting it here would be a
 * second author with less context.
 */
export function toPrompt(brief) {
  return (
    `${String(brief).trim()}\n\n` +
    'Photographic, editorial, corporate. Wide landscape composition with the ' +
    'subject to the right and uncluttered space on the left. ' +
    'NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks, NO ' +
    'user interface anywhere in the image: a headline is set over this ' +
    'afterwards and any lettering in the picture would collide with it.'
  );
}

/**
 * Make the banner for a post, or say why there isn't one.
 *
 * Never throws and never fails a draft. A post whose banner did not arrive is
 * still a post the rep can publish with an image of their own — losing the
 * whole campaign because a picture failed would be the worse trade by a mile.
 *
 * @param {string} brief What the banner should show.
 * @param {{env: object, cfg: object, storage: object, user: object}} ctx
 * @returns {Promise<{ok: true, url: string, remaining: number}
 *                 | {ok: false, reason: string}>}
 */
export async function generateImage(brief, ctx) {
  const { env, cfg, storage, user } = ctx;

  if (cfg.IMAGE_GENERATION !== 'on') {
    return { ok: false, reason: 'Banner generation is switched off for this deployment.' };
  }
  if (!brief || !String(brief).trim()) {
    return { ok: false, reason: 'No banner brief was written, so there was nothing to make.' };
  }
  if (!env.OPENAI_API_KEY) {
    return {
      ok: false,
      // Named as configuration rather than as a failure: a rep reading this
      // should hand it to an admin, not retry it.
      reason: 'No image provider key is configured for this environment, so the brief is all there is.',
    };
  }

  const allowance = monthlyAllowance(cfg);
  if (allowance <= 0) {
    return { ok: false, reason: 'No image budget is configured, so the brief is all there is.' };
  }

  // The whole team shares one monthly pot, which is what was agreed. The
  // counter is read-modify-write on KV and therefore NOT atomic: two requests
  // landing together can both see the same count and the month can overshoot
  // by a handful of images. That is tolerable for a budget guide and it is why
  // the hard ceiling belongs in the provider's own billing console, which
  // refuses over-budget requests no matter what this counter believes.
  const budget = await storage.checkRateLimit(
    `image:${monthKey()}`,
    allowance,
    secondsLeftInMonth(),
  );

  if (!budget.allowed) {
    return {
      ok: false,
      reason:
        `This month's image budget ($${cfg.IMAGE_MONTHLY_BUDGET_USD}, about ${allowance} banners) is spent. ` +
        'The post is unaffected; the banner brief below is what a designer needs.',
    };
  }

  let res;
  let payload;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.IMAGE_MODEL,
        prompt: toPrompt(brief),
        size: cfg.IMAGE_SIZE,
        quality: cfg.IMAGE_QUALITY,
        n: 1,
      }),
    });
    payload = await res.json();
  } catch (err) {
    console.error('[image] request failed:', err?.message || err);
    return { ok: false, reason: 'The image service could not be reached, so the brief is all there is.' };
  }

  if (!res.ok) {
    // The provider's own words, in the log and never in front of a rep: it is
    // an admin's problem and a rep can do nothing with "invalid_request_error".
    console.error(
      `[image] ${res.status} from ${cfg.IMAGE_MODEL}:`,
      JSON.stringify(payload?.error || payload).slice(0, 400),
    );
    return { ok: false, reason: 'The image service refused that one, so the brief is all there is.' };
  }

  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) {
    console.error('[image] no image in a 200 response:', JSON.stringify(payload).slice(0, 300));
    return { ok: false, reason: 'The image service returned nothing usable, so the brief is all there is.' };
  }

  let bytes;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch (err) {
    console.error('[image] could not decode the image:', err?.message || err);
    return { ok: false, reason: 'The image came back in a form this could not read.' };
  }

  // Stored the same way a generated deck is, so it is served by the same route
  // with the same expiry, and the rep can open it, save it, and lose it after
  // the same interval as everything else this produces. A banner is a handoff,
  // not an archive.
  const id = await storage.saveDocument({
    fileName: 'post-banner.png',
    contentType: 'image/png',
    bytes,
    title: 'LinkedIn post banner',
    disclosure: 'Generated image. Check it before posting: nothing here verifies what a model drew.',
    createdBy: user?.email || 'unknown',
  });

  return { ok: true, url: `/document/${id}`, remaining: budget.remaining };
}
