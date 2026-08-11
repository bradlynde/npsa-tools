#!/usr/bin/env node
/*
 * Validates the Word export against the real OOXML schema.
 *
 * This exists because four rounds of careful reasoning about the spec produced
 * three confident, wrong diagnoses. The export failed to open in Word; each round
 * found a genuine defect, fixed it, and the file still failed. What finally worked
 * was mechanical: build the same content with a different tool, confirm that one
 * opens, and validate both against the actual schema instead of against my reading
 * of it. The answer — a section-properties element in the wrong place, invalidating
 * every block after it — was in the first validation run.
 *
 * scripts/precall-docx.mjs asserts the specific invariants that came out of this,
 * and runs everywhere with no setup. This script is the thing that FINDS new ones,
 * and needs a JDK and ~28MB of jars, so it is deliberately separate and skips
 * cleanly when either is missing.
 *
 *   node scripts/precall-docx-schema.mjs            # generate and validate
 *   node scripts/precall-docx-schema.mjs a.docx …   # validate specific files
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';
import { repairDocx } from '../server/docx-repair.js';
import { preserveInlineSpacing } from '../server/docx-style.js';

const CACHE = process.env.OOXML_VALIDATOR_DIR || join(tmpdir(), 'npsa-ooxml-validator');
const JARS = [
  'org/apache/poi/poi/5.2.5/poi-5.2.5.jar',
  'org/apache/poi/poi-ooxml/5.2.5/poi-ooxml-5.2.5.jar',
  'org/apache/poi/poi-ooxml-full/5.2.5/poi-ooxml-full-5.2.5.jar',
  'org/apache/xmlbeans/xmlbeans/5.2.0/xmlbeans-5.2.0.jar',
  'commons-io/commons-io/2.15.1/commons-io-2.15.1.jar',
  'org/apache/commons/commons-compress/1.26.0/commons-compress-1.26.0.jar',
  'org/apache/logging/log4j/log4j-api/2.22.1/log4j-api-2.22.1.jar',
  'commons-codec/commons-codec/1.16.0/commons-codec-1.16.0.jar',
  'org/apache/commons/commons-collections4/4.4/commons-collections4-4.4.jar',
];

const skip = (why) => { console.log(`SKIP  ${why}`); process.exit(0); };

try { execSync('javac -version', { stdio: 'ignore' }); }
catch { skip('no JDK on this machine — run scripts/precall-docx.mjs instead, which needs none'); }

mkdirSync(CACHE, { recursive: true });
for (const path of JARS) {
  const jar = join(CACHE, path.split('/').pop());
  if (existsSync(jar)) continue;
  try {
    execFileSync('curl', ['-sSf', '--max-time', '180', '-o', jar,
      `https://repo1.maven.org/maven2/${path}`], { stdio: 'ignore' });
  } catch { skip(`could not fetch ${path.split('/').pop()} from Maven Central`); }
}

const JAVA = String.raw`
import org.apache.xmlbeans.*;
import java.io.*; import java.util.*; import java.util.zip.*;
public class V {
  static XmlObject parse(String p, InputStream in) throws Exception {
    switch (p) {
      case "word/document.xml":  return org.openxmlformats.schemas.wordprocessingml.x2006.main.DocumentDocument.Factory.parse(in);
      case "word/styles.xml":    return org.openxmlformats.schemas.wordprocessingml.x2006.main.StylesDocument.Factory.parse(in);
      case "word/numbering.xml": return org.openxmlformats.schemas.wordprocessingml.x2006.main.NumberingDocument.Factory.parse(in);
      case "word/settings.xml":  return org.openxmlformats.schemas.wordprocessingml.x2006.main.SettingsDocument.Factory.parse(in);
      default: return XmlObject.Factory.parse(in);
    }
  }
  public static void main(String[] a) throws Exception {
    String[] parts = {"word/document.xml","word/styles.xml","word/numbering.xml","word/settings.xml"};
    int bad = 0;
    for (String path : a) {
      System.out.println(new File(path).getName());
      ZipFile z = new ZipFile(path);
      for (String part : parts) {
        ZipEntry e = z.getEntry(part);
        if (e == null) continue;
        XmlObject xo;
        try (InputStream in = z.getInputStream(e)) { xo = parse(part, in); }
        catch (Exception ex) { System.out.println("  UNPARSEABLE " + part + " : " + ex.getMessage()); bad++; continue; }
        List<XmlError> errs = new ArrayList<>();
        xo.validate(new XmlOptions().setErrorListener(errs));
        // Every genuine Word file carries mc:Ignorable and the w14 extensions;
        // the base schema has no wildcard for them, so they are not real findings.
        errs.removeIf(x -> x.getMessage() != null && (x.getMessage().contains("Ignorable")
            || x.getMessage().contains("schemas.microsoft.com/office/word/2010")));
        if (errs.isEmpty()) { System.out.println("  valid    " + part); continue; }
        bad++;
        System.out.println("  INVALID  " + part + "  (" + errs.size() + ")");
        int n = 0;
        for (XmlError err : errs) {
          if (n++ >= 10) { System.out.println("      ... " + (errs.size() - 10) + " more"); break; }
          System.out.println("      " + err.getMessage());
        }
      }
      z.close();
    }
    System.exit(bad == 0 ? 0 : 1);
  }
}`;

writeFileSync(join(CACHE, 'V.java'), JAVA);
const cp = readdirSync(CACHE).filter((f) => f.endsWith('.jar')).map((f) => join(CACHE, f)).join(':');
try { execFileSync('javac', ['-cp', cp, join(CACHE, 'V.java')], { stdio: 'pipe' }); }
catch (e) { skip(`could not compile the validator: ${e.message.slice(0, 200)}`); }

let files = process.argv.slice(2);
if (!files.length) {
  // The shape that actually ships: headings, bullets, a numbered list, links and
  // a table, which between them exercise every part the library writes.
  const MD = `# Plainfield Christian Church — IN
**Tuesday, August 11, 2026 · 10:00 AM CST** · NPSA 30-Minute Introduction Call

## NSGP Funding Snapshot

| Track | Cap | Stackable |
| --- | --- | --- |
| Federal NSGP | $200,000 per site | — |
| Indiana | no state program | n/a |

## Meeting Details
- **Church Website:** [https://plainfieldchristian.org](https://plainfieldchristian.org)

## Attendees
**Jeff Kaiser** · Managing Partner, NPSA · jeff@lyndeconsulting.com

## Discovery Questions to Ask
1. Do you expect to expand or remodel within the next few years?
2. What does your current camera coverage look like?
`;
  const html = `<html><head><meta charset="utf-8"></head><body>${marked(MD)}</body></html>`;
  const gen = await HTMLtoDOCX(preserveInlineSpacing(html), null, {
    title: 'Pre-Call Notes',
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
    font: 'Arial', fontSize: 21, lineHeight: 240,
  });
  const out = join(CACHE, 'generated.docx');
  writeFileSync(out, await repairDocx(gen, { brand: true }));
  files = [out];
  console.log('validating a freshly generated briefing\n');
}

try {
  console.log(execFileSync('java', ['-cp', `${cp}:${CACHE}`, 'V', ...files],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  console.log('schema-valid');
} catch (e) {
  console.log(e.stdout || e.message);
  console.log('SCHEMA ERRORS — Word will refuse this file');
  process.exit(1);
}
