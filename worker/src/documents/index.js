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
    sections: spec.sections.length,
    // Always present: this is the Worker's own copy and does not depend on
    // Graph being reachable.
    downloadPath: `/document/${id}`,
    sharePointUrl: delivery.delivered ? delivery.webUrl : null,
    filed: delivery.delivered,
    filingReason: delivery.delivered ? null : delivery.reason,
  };
}
