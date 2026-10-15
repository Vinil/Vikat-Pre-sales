/**
 * documents/index.js — generate a document, keep it, and file it.
 *
 * One entry point, because the three steps are not independent: a document
 * that renders but is not kept cannot be handed to the rep, and one that is
 * kept but not filed still needs saying so.
 *
 * Ordering is deliberate. The KV copy is written before the SharePoint upload
 * is attempted, so a Graph outage costs the rep nothing — they still get a
 * link that works.
 */

import { normaliseSpec, fileNameFor, DISCLOSURE_LABELS } from './spec.js';
import { renderPptx, fitsCover } from './pptx.js';
import { brandFor } from './house.js';
import { productOf } from '../product.js';
import { inspectPptx, inspectionSummary } from './inspect.js';
import { checkGuidelines } from './guidelines.js';
import { checkArticulation } from '../articulation.js';
import { REFERENCES_KEY, forbiddenNames } from '../references.js';
import { checkExecOutreach, recapShare, outreachText } from '../execOutreach.js';
import { renderPdf } from './pdf.js';
import { renderDocx } from './docx.js';
import { deliverDocument } from '../documentStore.js';

const CONTENT_TYPE = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * A deck for another product, without the suite slides it will not draw.
 *
 * The suite deep dive is SecSemantic or DevSemantic by definition, and the
 * renderer leaves it out of a deck that is not on the security line (see
 * brandFor). Everything after the renderer read the spec, though: the result
 * counted the slide, and the inspection, the guidelines and the outreach rules
 * reported on words that were never drawn. The rep could be told about a slide
 * that is not in the file. So it comes out here, before anything is drawn or
 * checked, and a note says so, so that the model can tell the rep instead of
 * describing it.
 *
 * A deck only. Only the deck is branded for the product; a pdf or a docx is
 * built as it always was.
 *
 * @returns {{ spec: object, leftOut: string[] }}  `leftOut` is the note, if any.
 */
function withoutForeignSuite(spec, product) {
  if (spec.format !== 'pptx' || brandFor(product).suite) return { spec, leftOut: [] };

  const suite = spec.sections.filter((s) => s.layout === 'suite');
  if (!suite.length) return { spec, leftOut: [] };

  const titles = suite.map((s) => `"${s.title || s.suite}"`).join(', ');
  const which = suite.length === 1 ? `The suite slide ${titles} was` : `The suite slides ${titles} were`;
  return {
    spec: { ...spec, sections: spec.sections.filter((s) => s.layout !== 'suite') },
    leftOut: [
      `${which} left out: the suite deep dive belongs to the security line, and this is a ` +
        `${productOf(product).name} deck.`,
    ],
  };
}

/**
 * A product's positioning line that the deck could not carry, said.
 *
 * Another product's cover and close carry its definition's headline, and a
 * headline past three cover lines is a paragraph: the renderer leaves it off
 * both and writes nothing in its place (fitsCover). Left there, neither the
 * model nor the rep knows the deck has no positioning line, or why. Said, the
 * model can tell the rep, and the rep can tell whoever owns the definition,
 * which is where the line gets shorter. A deck only, as for the suite.
 *
 * @returns {string[]}  The note, if any.
 */
function lineLeftOff(spec, product, metrics) {
  const { positioningLine } = brandFor(product);
  if (spec.format !== 'pptx' || !positioningLine || fitsCover(positioningLine, metrics)) return [];

  const { name } = productOf(product);
  return [
    `The headline of the ${name} definition was left off the cover and the close: at that length it is ` +
      'a paragraph, not a cover line. Do not write a line in its place; tell the rep, so that whoever ' +
      `owns the ${name} definition can shorten it. The headline is the definition up to its first ` +
      'colon, or all of it when there is none.',
  ];
}

/**
 * Render, store and deliver.
 *
 * @param {object} input     The model's spec, unvalidated.
 * @param {object} ctx
 * @param {object} ctx.storage
 * @param {{ email: string, name?: string }} ctx.user
 * @param {Record<string, unknown>} ctx.env
 * @param {object} ctx.cfg
 * @param {{ bytes: object, metrics: object }} ctx.fonts
 * @param {import('../product.js').Product|null} [ctx.product]
 *        What the rep is selling, when the page around the assistant says so.
 *        A deck is branded for it, and the outreach check accepts its own
 *        wording. Absent, both are what they always were.
 * @param {string} [ctx.isoDate]  Fixed in tests; now in production.
 * @returns {Promise<{ ok: false, error: string } | { ok: true, ... }>}
 */
export async function createDocument(input, ctx) {
  const parsed = normaliseSpec(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { storage, user, env, cfg, fonts, product = null } = ctx;
  const { spec, leftOut } = withoutForeignSuite(parsed.spec, product);
  const isoDate = ctx.isoDate || new Date().toISOString();
  const preparedBy = user.name || user.email;

  const bytes =
    spec.format === 'pdf'
      ? await renderPdf(spec, { preparedBy, isoDate }, fonts)
      : spec.format === 'docx'
        ? renderDocx(spec, { preparedBy, isoDate })
        : renderPptx(spec, { preparedBy, isoDate, product }, fonts.metrics);

  // Look at what was built before handing it over. Reporting, never
  // rewriting: a deck a shade under a threshold is still a deck, and refusing
  // it would leave the rep with nothing five minutes before a call.
  //
  // GEOMETRY only. inspectPptx unzips a file and measures shapes, which it can
  // do for one format; everything that reads TEXT has to run for all three,
  // and that distinction is the whole reason the checks below moved.
  const rendered = spec.format === 'pptx' ? inspectPptx(bytes, spec) : { problems: [], notes: [] };

  // The brand guidelines, on every format rather than only the one that can be
  // unzipped. A one-pager wearing two suite accents is as far outside them as a
  // deck is, and inspectPptx cannot see a PDF at all.
  const brand = checkGuidelines(spec);

  // The standing rules for exec outreach, on EVERY format.
  //
  // This is the hole the McLane PDF went through. The truncation check added
  // after a deck shipped with cut text lived inside inspectPptx, so a pdf got
  // `{ problems: [], notes: [] }` and nothing else — and the next document to
  // reach a customer was a pdf with four sentences cut mid-word, a retired
  // phrase, an unsourced 7.5x, and an internal clearance stamp on all three
  // pages. The rep's report came back clean, because for a pdf there was
  // nothing to come back.
  //
  // A text rule has no business knowing which renderer ran.
  // Names the approved references say must not be printed. Read here rather
  // than trusted to the prompt: the block the model sees has them stripped
  // out, so this is the only place that knows what to look for.
  let forbidden = [];
  try {
    forbidden = forbiddenNames(await storage.getSetting(REFERENCES_KEY));
  } catch (err) {
    console.error('[documents] references unavailable:', err?.message || err);
  }

  const outreach = checkExecOutreach({ ...spec, preparedBy }, { forbidden, product });

  // How it SOUNDS, which nothing was asking.
  //
  // articulation.js exists to answer one question — would a reader think a
  // machine wrote this — and checkArticulation() was called by nothing at all.
  // Not by this pipeline, not by the outreach drafter, not by anything. It was
  // written, tested, and never run, so its whole list (essay connectives, the
  // "not just X, it's Y" construction, stacked hedging, dashes in narrative
  // copy, the assistant sign-off, melodrama) has been reaching customers
  // untouched since the module landed. ARTICULATION_BLOCK was in the system
  // prompt, which is the half that asks nicely.
  //
  // Advisory by design and reported like every other note here: voice is a
  // judgement, and a checker that blocked on it would be wrong about a good
  // sentence sooner or later.
  for (const n of checkArticulation(outreachText(spec)).notes) outreach.notes.push(n);

  // Recap, measured on the OPENING rather than the whole document.
  //
  // The review's sharpest point was about where recap sits, not how much of it
  // there is: "page 1 is half recap", and "he knows McLane has 80 DCs". Later
  // sections legitimately name the customer on every line — that is what
  // "priced in their business" reads like. Averaged over the whole document
  // the opening's 5-in-8 disappeared into 8-in-25 and the note never fired.
  const opening = spec.sections[0];
  const recap = opening
    ? recapShare(
        [opening.title, opening.body, ...(opening.points || [])].filter(Boolean).join('\n'),
        spec.audience,
      )
    : null;

  if (recap && recap.share > 0.5 && recap.sentences >= 4) {
    outreach.notes.push(
      `${recap.about} of the opening section's ${recap.sentences} sentences are about ${spec.audience}. ` +
        'They already know their own business. Recap buys attention for one line and spends it after ' +
        'that: pivot on the first, and spend the rest on what they do not already have.',
    );
  }

  const inspection = {
    ...rendered,
    problems: [...rendered.problems, ...brand.problems, ...outreach.problems],
    notes: [
      ...leftOut,
      ...lineLeftOff(spec, product, fonts.metrics),
      ...rendered.notes,
      ...brand.notes,
      ...outreach.notes,
    ],
  };

  const fileName = fileNameFor(spec, isoDate);
  const contentType = CONTENT_TYPE[spec.format];

  const id = await storage.saveDocument({
    fileName,
    contentType,
    bytes,
    title: spec.title,
    disclosure: spec.disclosure,
    createdBy: user.email,
    createdAt: isoDate,
  });

  const delivery = await deliverDocument({ fileName, bytes, contentType }, env, cfg);

  return {
    ok: true,
    id,
    fileName,
    format: spec.format,
    title: spec.title,
    disclosure: spec.disclosure,
    disclosureLabel: DISCLOSURE_LABELS[spec.disclosure],
    sizeBytes: bytes.byteLength,
    inspection: inspectionSummary(inspection),
    sections: spec.sections.length,
    // Always present: this is the Worker's own copy and does not depend on
    // Graph being reachable.
    downloadPath: `/document/${id}`,
    sharePointUrl: delivery.delivered ? delivery.webUrl : null,
    filed: delivery.delivered,
    filingReason: delivery.delivered ? null : delivery.reason,
  };
}
