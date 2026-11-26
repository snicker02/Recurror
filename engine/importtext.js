// Recurror — load a document from pasted text.
//
// Documents shared as text (saved files opened in an editor, chat messages, notes apps) pick up
// damage on the way: code fences, backticks around values, curly quotes, non-breaking spaces,
// markdown escapes, a sentence before or after the JSON. parseDocText repairs those one step at a
// time, only as far as needed for the text to parse, and reports what it fixed.

const STEPS = [
  ['removed code fences', (t) => t.replace(/```[a-zA-Z0-9_-]*\s*\n?/g, '')],
  ['kept only the JSON (text before or after it was dropped)', (t) => {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    return a >= 0 && b > a ? t.slice(a, b + 1) : t;
  }],
  ['removed backticks around values', (t) => t.replace(/"`([^"`]*)`"/g, '"$1"').replace(/`/g, '')],
  ['straightened curly quotes', (t) => t.replace(/[“”„‟″‶]/g, '"').replace(/[‘’‚‛′‵]/g, "'")],
  ['replaced non-breaking and zero-width spaces', (t) => t.replace(/[   ]/g, ' ').replace(/[​-‍﻿]/g, '')],
  ['removed markdown escapes', (t) => t.replace(/\\([_*[\]()#~>!|-])/g, '$1')],
  ['removed trailing commas', (t) => t.replace(/,(\s*[}\]])/g, '$1')],
];

const unwrap = (x) => { const m = /^\s*`+([^`]*)`+\s*$/.exec(x); return m ? m[1] : x; };
const tryParse = (t) => { try { return { ok: true, v: JSON.parse(t) } } catch (e) { return { ok: false, err: e } } };

/**
 * Parse pasted document text. Returns { doc, kind, fixes } where kind is 'doc' (a whole drawing)
 * or 'strokes' (a copied set of strokes); throws with a readable message otherwise.
 */
export function parseDocText(text) {
  let t = String(text ?? '').trim();
  if (!t) throw new Error('There is no text to import.');
  const fixes = [];
  let r = tryParse(t);
  for (const [label, fix] of STEPS) {
    if (r.ok) break;
    const n = fix(t);
    if (n !== t) { t = n; fixes.push(label); r = tryParse(t); }
  }
  if (!r.ok) throw new Error(`This isn't valid JSON, even after cleaning it up (${r.err.message}). Check that the whole text was copied.`);
  // backticks inside strings are still valid JSON ("`#0e0f13`"), so unwrap them after parsing too
  let unwrapped = 0;
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach((x, i) => { if (typeof x === 'string') { const u = unwrap(x); if (u !== x) { o[i] = u; unwrapped++; } } else walk(x); }); }
    else if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      const x = o[k];
      if (typeof x === 'string') { const u = unwrap(x); if (u !== x) { o[k] = u; unwrapped++; } } else walk(x);
    }
  };
  walk(r.v);
  if (unwrapped && !fixes.includes('removed backticks around values')) fixes.push('removed backticks around values');
  const v = r.v;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('This JSON is not a Recurror drawing.');
  if (v.format === 'recurror-doc' || (Array.isArray(v.strokes) && (v.width || v.layers))) return { doc: v, kind: 'doc', fixes };
  if (Array.isArray(v.strokes)) return { doc: v, kind: 'strokes', fixes };
  throw new Error('This JSON is not a Recurror drawing (no strokes in it).');
}

/** Does this text look like a Recurror document or stroke set (cheap test for paste events)? */
export function looksLikeDocText(text) {
  const t = String(text ?? '');
  return t.length > 20 && /"strokes"\s*:/.test(t) && /[{]/.test(t);
}
