/**
 * Which tool schemas this isolate has watched the API refuse.
 *
 * "Schema is too complex." is a request-level 400. It names no tool, and it
 * fails the whole request — including a "hi" that would never have called one.
 * The only way to learn which schema is at fault is to shed one and see if the
 * next request is accepted, so that discovery is remembered here rather than
 * repeated on every message.
 *
 * Isolate-scoped on purpose. It caches an OBSERVED FACT about the deployed
 * schemas, not configuration: a deploy that fixes a schema starts fresh
 * isolates with an empty set, so a corrected tool comes back on its own with
 * no cache to invalidate by hand.
 */
const refused = new Set();

/** Tool names this isolate has seen refused. */
export function refusedTools() {
  return refused;
}

/** Record a refusal. Returns the name, so callers can log it in one line. */
export function noteRefusal(name) {
  refused.add(name);
  return name;
}

/** Test seam. Production never calls this — a deploy clears the set instead. */
export function forgetRefusals() {
  refused.clear();
}

/**
 * Rough grammar cost of a tool schema, used to pick what to shed first.
 *
 * Under `strict` the schema is compiled into a constrained-decoding grammar,
 * and the expensive parts are not size but BRANCHING: every enum value is an
 * alternative, and every union type (`['string', 'null']`) doubles the shapes
 * the grammar has to admit. Unions are weighted accordingly — six of them in
 * one tool is 64 shapes, which is what took production down.
 */
export function schemaCost(tool) {
  const props = Object.values(tool.input_schema?.properties || {});
  return props.reduce(
    (n, p) => n + 1 + (p.enum?.length || 0) + (Array.isArray(p.type) ? p.type.length * 4 : 0),
    0,
  );
}
