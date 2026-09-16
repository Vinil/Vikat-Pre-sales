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
import { renderPptx } from './pptx.js';
import { inspectPptx, inspectionSummary } from './inspect.js';
import { checkGuidelines } from './guidelines.js';
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
 * Render, store and deliver.
 *
 * @param {object} input     The model's spec, unvalidated.
 * @param {object} ctx
 * @param {object} ctx.storage
 * @param {{ email: string, name?: string }} ctx.user
 * @param {Record<string, unknown>} ctx.env
 * @param {object} ctx.cfg
 * @param {{ bytes: object, metrics: object }} ctx.fonts
 * @param {string} [ctx.isoDate]  Fixed in tests; now in production.
 * @returns {Promise<{ ok: false, error: string } | { ok: true, ... }>}
 */
export async function createDocument(input, ctx) {
  const parsed = normaliseSpec(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { spec } = parsed;
  const { storage, user, env, cfg, fonts } = ctx;
  const isoDate = ctx.isoDate || new Date().toISOString();
  const preparedBy = user.name || user.email;

  const bytes =
    spec.format === 'pdf'
      ? await renderPdf(spec, { preparedBy, isoDate }, fonts)
      : spec.format === 'docx'
        ? renderDocx(spec, { preparedBy, isoDate })
        : renderPptx(spec, { preparedBy, isoDate }, fonts.metrics);

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
  const outreach = checkExecOutreach({ ...spec, preparedBy });

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
    notes: [...rendered.notes, ...brand.notes, ...outreach.notes],
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
