import { Ajv, type ErrorObject } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';

// ajv-formats is a CommonJS module whose plugin is its default export, which NodeNext hands over one level down.
type FormatsPlugin = (ajv: Ajv) => unknown;
const addFormats: FormatsPlugin =
  (formats as unknown as { default?: FormatsPlugin }).default ??
  (formats as unknown as FormatsPlugin);

/** One thing wrong with a run's input, named by the field a caller would fix. */
export interface InputError {
  field: string;
  message: string;
}

export type InputCheck = { ok: true } | { ok: false; errors: InputError[]; unusable?: boolean };

const FORMAT = /"format"\s*:\s*"([^"]+)"/g;

/**
 * Checks a run's `input.params` against its pack's `inputsSchema` (the schema describes the params; the request text is
 * separate). The same rules the New Run form applies, so the API cannot be used to skip them: nothing is coerced or
 * removed, an empty schema accepts anything, and a schema that cannot be compiled, or uses a format nobody here knows,
 * is an error rather than a silent pass.
 */
export function checkPackInputs(schema: Record<string, unknown>, params: unknown): InputCheck {
  if (Object.keys(schema).length === 0) return { ok: true };
  try {
    if (schema.$async) throw new Error('Async schemas are not supported');
    const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
    const options = { allErrors: true, strict: false, logger: false as const };
    const ajv = dialect.includes('2020-12')
      ? new Ajv2020(options)
      : dialect.includes('2019-09')
        ? new Ajv2019(options)
        : new Ajv(options);
    addFormats(ajv);
    // A work-item reference is opaque here; its source adapter resolves it.
    ajv.addFormat('work-item', { type: 'string', validate: (v: string) => v.trim().length > 0 });
    for (const m of JSON.stringify(schema).matchAll(FORMAT))
      if (!ajv.formats[m[1]!]) throw new Error(`Unsupported format: ${m[1]}`);
    const validate = ajv.compile(schema);
    if (validate(params ?? {})) return { ok: true };
    return { ok: false, errors: (validate.errors ?? []).map(toInputError) };
  } catch {
    return {
      ok: false,
      unusable: true,
      errors: [
        {
          field: 'input.params',
          message: 'This pack’s input schema could not be applied, so it cannot start a run yet',
        },
      ],
    };
  }
}

/** `/audience` becomes `input.params.audience`; a missing required property is reported on the property itself. */
function toInputError(e: ErrorObject): InputError {
  const parts = e.instancePath.split('/').slice(1).map(unescape);
  if (e.keyword === 'required' && typeof e.params.missingProperty === 'string')
    parts.push(e.params.missingProperty);
  return { field: ['input', 'params', ...parts].join('.'), message: e.message ?? 'is not valid' };
}

const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');
