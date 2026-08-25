/**
 * ooxml.js — the small amount of OOXML plumbing a PPTX needs.
 *
 * A .pptx is a ZIP of XML parts. There is no lighter way in: the alternative
 * is a presentation library, and every one of them assumes Node's fs or a
 * DOM. This file holds the parts that never vary — content types, rels,
 * theme, master, layout — so pptx.js is only about drawing slides.
 *
 * The theme carries the brand palette and typefaces so that anything
 * PowerPoint generates itself (a chart, a new text box a rep adds later)
 * comes out on-brand rather than in Office defaults.
 */

import { COLOR, FONT } from '../brand.js';

/** English Metric Units per inch. All OOXML geometry is in EMU. */
export const EMU_PER_INCH = 914400;
export const emu = (inches) => Math.round(inches * EMU_PER_INCH);

/** 16:9, the only aspect ratio a sales deck is ever shown in. */
export const SLIDE = { widthIn: 13.333, heightIn: 7.5 };

/** OOXML wants bare hex, no leading hash. */
export const hex = (color) => String(color).replace('#', '').toUpperCase();

// Control characters are not representable in XML 1.0. Left in, they make the
// file unopenable rather than merely wrong, so they are dropped outright.
const XML_ILLEGAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Escape text for an XML text node or attribute value. */
export function xml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(XML_ILLEGAL_RE, '');
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function contentTypes(slideCount) {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('');

  return `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

export const rootRels = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

export function presentation(slideCount) {
  // Slide ids must be >= 256; rIds start after the master.
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('');

  return `${DECL}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst>
<p:sldSz cx="${emu(SLIDE.widthIn)}" cy="${emu(SLIDE.heightIn)}"/>
<p:notesSz cx="${emu(SLIDE.heightIn)}" cy="${emu(SLIDE.widthIn)}"/>
</p:presentation>`;
}

export function presentationRels(slideCount) {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('');

  return `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slides}
<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;
}

/**
 * The theme. Office reads accent1..6 for anything a user adds later, so the
 * brand palette is loaded here rather than only onto the shapes we draw.
 */
export const theme = `${DECL}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vikat.AI">
<a:themeElements>
<a:clrScheme name="Vikat.AI">
<a:dk1><a:srgbClr val="${hex(COLOR.deepNavy)}"/></a:dk1>
<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="${hex(COLOR.navy)}"/></a:dk2>
<a:lt2><a:srgbClr val="${hex(COLOR.cream)}"/></a:lt2>
<a:accent1><a:srgbClr val="${hex(COLOR.navy)}"/></a:accent1>
<a:accent2><a:srgbClr val="${hex(COLOR.circuitTeal)}"/></a:accent2>
<a:accent3><a:srgbClr val="${hex(COLOR.signalGreen)}"/></a:accent3>
<a:accent4><a:srgbClr val="${hex(COLOR.deepNavy)}"/></a:accent4>
<a:accent5><a:srgbClr val="${hex(COLOR.cream)}"/></a:accent5>
<a:accent6><a:srgbClr val="${hex(COLOR.circuitTeal)}"/></a:accent6>
<a:hlink><a:srgbClr val="${hex(COLOR.circuitTeal)}"/></a:hlink>
<a:folHlink><a:srgbClr val="${hex(COLOR.navy)}"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Vikat.AI">
<a:majorFont><a:latin typeface="${FONT.display.family}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="${FONT.body.family}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Vikat.AI">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="15875"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;

/**
 * Master and layout are deliberately free of placeholders: every slide draws
 * its own shapes at absolute positions. Placeholders would let PowerPoint
 * re-flow the layout on open, which is the one thing a brand-controlled
 * renderer must not allow.
 */
export const slideMaster = `${DECL}
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

export const slideMasterRels = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

export const slideLayout = `${DECL}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

export const slideLayoutRels = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

export const slideRels = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

export function coreProps({ title, author, created }) {
  return `${DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(title)}</dc:title>
<dc:creator>${xml(author)}</dc:creator>
<cp:lastModifiedBy>${xml(author)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${xml(created)}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${xml(created)}</dcterms:modified>
</cp:coreProperties>`;
}

export function appProps(slideCount) {
  return `${DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Vikat.AI Sales Assistant</Application>
<Slides>${slideCount}</Slides>
<ScaleCrop>false</ScaleCrop>
<LinksUpToDate>false</LinksUpToDate>
<SharedDoc>false</SharedDoc>
<HyperlinksChanged>false</HyperlinksChanged>
</Properties>`;
}
